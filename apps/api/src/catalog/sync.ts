import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  CATALOG_MATCHES,
  type CatalogMatch,
  type CatalogProfile,
  type CatalogReport,
  type CatalogReportRow,
  type MembershipStatus,
  MEMBERSHIP_STATUSES,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import type { UserRow } from "../auth/sessions.js";
import { AppError } from "../errors.js";
import { visibleSql } from "../directory/common.js";
import {
  CatalogError,
  maskValue,
  SENSITIVE_FIELDS,
  type Catalog,
  type CatalogPerson,
  type CatalogProfileData,
} from "./catalog.js";

/**
 * Синхронизация людей YourTask с общим каталогом YourSpace (R-2.2, YT-03, docs/adr/0009).
 *
 * - Первый запуск: забираем весь каталог, сопоставляем людей, заведённых вручную до перехода
 *   (по аккаунту YourSpace, затем по почте), остальных создаём. Всё, что не сопоставилось, — в отчёт.
 * - Дальше: опрашиваем ленту событий и перечитываем профиль каждого изменённого человека.
 * - Деактивация в каталоге сразу отзывает все сессии YourTask; человек остаётся в истории с именем.
 */
const CURSOR_KEY = "events_cursor";
const LAST_SYNC_KEY = "last_sync_at";
const LAST_ERROR_KEY = "last_error";
const PROFILE_CONCURRENCY = 8;

interface LocalRow {
  id: string;
  yourspace_subject: string | null;
  email: string | null;
  name: string;
  role: "superadmin" | "member";
  is_test: number;
  deactivated_at: number | null;
  catalog_match: CatalogMatch;
}

interface ProfileRow {
  user_id: string;
  username: string;
  full_name: string | null;
  nickname: string | null;
  telegram: string | null;
  vk: string | null;
  city: string | null;
  timezone: string | null;
  portfolio: string | null;
  role_title: string | null;
  membership_status: string | null;
  joined_at: string | null;
  tenure: string | null;
  availability_hours: number | null;
  gitea_login: string | null;
  perforce_login: string | null;
  masks: string;
  synced_at: number;
}

export interface SyncOptions {
  db: Database;
  catalog: Catalog;
  logger: FastifyBaseLogger;
  superadminEmails: readonly string[];
  /** Отзывает все сессии человека (SessionStore.revokeAll). */
  revokeSessions: (userId: string) => number;
}

const displayName = (person: CatalogPerson) => person.fullName?.trim() || person.displayName;

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run));
  }
}

export class CatalogSync {
  private running: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SyncOptions) {}

  get catalog() {
    return this.options.catalog;
  }

  private get db() {
    return this.options.db;
  }

  private state(key: string) {
    return (this.db.prepare("SELECT value FROM catalog_state WHERE key = ?").get(key) as { value: string } | undefined)
      ?.value;
  }

  private setState(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM catalog_state WHERE key = ?").run(key);
    else
      this.db
        .prepare(
          "INSERT INTO catalog_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
  }

  /** Последовательное выполнение: две синхронизации одновременно не идут. */
  private exclusive(task: () => Promise<void>): Promise<void> {
    const next = this.running.then(task, task);
    this.running = next.catch(() => undefined);
    return next;
  }

  private async guarded(task: () => Promise<void>) {
    try {
      await task();
      this.setState(LAST_SYNC_KEY, String(Date.now()));
      this.setState(LAST_ERROR_KEY, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState(LAST_ERROR_KEY, message.slice(0, 500));
      this.options.logger.error({ err: error }, "Catalog sync failed");
      throw error;
    }
  }

  /** Полная синхронизация при первом запуске, дальше — по ленте событий. */
  sync(): Promise<void> {
    return this.exclusive(() => this.guarded(() => (this.state(CURSOR_KEY) ? this.pollEvents() : this.fullSync())));
  }

  /** Полная пересборка: весь каталог и сопоставление (можно запускать повторно). */
  resync(): Promise<void> {
    return this.exclusive(() => this.guarded(() => this.fullSync()));
  }

  /** Периодический опрос ленты событий (первая синхронизация выполняется при создании приложения). */
  start(intervalSeconds: number) {
    const tick = () => this.sync().catch(() => undefined);
    if (intervalSeconds > 0 && !this.timer) {
      this.timer = setInterval(tick, intervalSeconds * 1000);
      this.timer.unref();
    }
  }

  /** Останавливает опрос и дожидается текущей синхронизации. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async fullSync() {
    // Курсор берём до чтения списка: изменения, случившиеся во время чтения, придут событиями.
    let cursor = Number(this.state(CURSOR_KEY) ?? 0);
    for (;;) {
      const page = await this.catalog.events(cursor);
      if (page.items.length === 0) break;
      cursor = page.next;
    }
    const people = await this.catalog.list();
    const seen = new Set(people.map((person) => person.id));
    const profiles = new Map<string, CatalogProfileData | null>();
    const linkedMissing = (
      this.db.prepare("SELECT yourspace_subject AS id FROM users WHERE yourspace_subject IS NOT NULL").all() as {
        id: string;
      }[]
    )
      .map((row) => row.id)
      .filter((id) => !seen.has(id));
    await inBatches([...seen, ...linkedMissing], PROFILE_CONCURRENCY, async (id) => {
      profiles.set(id, await this.catalog.profile(id));
    });
    this.db.transaction(() => {
      for (const person of people) this.apply(person, profiles.get(person.id) ?? null);
      for (const id of linkedMissing) this.applyMissing(id, profiles.get(id) ?? null);
    })();
    this.setState(CURSOR_KEY, String(cursor));
    this.options.logger.info({ people: people.length }, "Catalog synced");
  }

  private async pollEvents() {
    let cursor = Number(this.state(CURSOR_KEY) ?? 0);
    for (;;) {
      const page = await this.catalog.events(cursor);
      if (page.items.length === 0) break;
      const ids = [...new Set(page.items.map((event) => event.userId))];
      const profiles = new Map<string, CatalogProfileData | null>();
      await inBatches(ids, PROFILE_CONCURRENCY, async (id) => {
        profiles.set(id, await this.catalog.profile(id));
      });
      this.db.transaction(() => {
        for (const id of ids) this.applyMissing(id, profiles.get(id) ?? null);
      })();
      cursor = page.next;
      this.setState(CURSOR_KEY, String(cursor));
    }
  }

  /** Перечитывает одного человека — перед входом, чтобы новый участник входил сразу, а ушедший — нет. */
  async refresh(subject: string): Promise<void> {
    const profile = await this.catalog.profile(subject);
    this.db.transaction(() => this.applyMissing(subject, profile))();
  }

  private bySubject(subject: string) {
    return this.db.prepare("SELECT * FROM users WHERE yourspace_subject = ?").get(subject) as LocalRow | undefined;
  }

  private applyMissing(subject: string, profile: CatalogProfileData | null) {
    if (profile) return this.apply(profile, profile);
    // Аккаунта больше нет в каталоге: закрываем вход, имя остаётся в истории.
    const local = this.bySubject(subject);
    if (local) this.deactivate(local, Date.now());
  }

  private deactivate(local: LocalRow, at: number) {
    if (local.deactivated_at === null) {
      this.db.prepare("UPDATE users SET deactivated_at = ?, updated_at = ? WHERE id = ?").run(at, Date.now(), local.id);
      local.deactivated_at = at;
    }
    const revoked = this.options.revokeSessions(local.id);
    if (revoked) this.options.logger.info({ userId: local.id, revoked }, "Sessions revoked: deactivated in catalog");
  }

  /** Создаёт или обновляет человека YourTask по записи каталога. */
  private apply(person: CatalogPerson, profile: CatalogProfileData | null) {
    const now = Date.now();
    const email = person.contactEmail?.trim().toLowerCase() || null;
    let local = this.bySubject(person.id);
    if (!local && email) {
      // Заведён вручную до перехода: сопоставляем по почте, только если совпадение однозначное.
      const legacy = this.db
        .prepare("SELECT * FROM users WHERE yourspace_subject IS NULL AND catalog_match = 'unresolved' AND email = ?")
        .all(email) as LocalRow[];
      if (legacy.length === 1 && legacy[0]) {
        local = legacy[0];
        this.db
          .prepare("UPDATE users SET yourspace_subject = ?, catalog_match = 'email', updated_at = ? WHERE id = ?")
          .run(person.id, now, local.id);
        local.catalog_match = "email";
      }
    }
    if (!local) {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO users (id, yourspace_subject, email, name, role, locale, is_test, catalog_match, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'member', 'ru', 0, 'created', ?, ?)`,
        )
        .run(id, person.id, email, displayName(person), now, now);
      local = this.bySubject(person.id) as LocalRow;
    }

    const superadmin =
      person.role === "superadmin" || (email !== null && this.options.superadminEmails.includes(email));
    this.db
      .prepare("UPDATE users SET email = ?, name = ?, role = ?, updated_at = ? WHERE id = ?")
      .run(email, displayName(person), superadmin ? "superadmin" : "member", now, local.id);
    if (local.catalog_match === "unresolved") {
      this.db.prepare("UPDATE users SET catalog_match = 'subject' WHERE id = ?").run(local.id);
    }

    if (!person.active || person.erased) this.deactivate(local, person.deactivatedAt ?? now);
    else if (local.deactivated_at !== null && local.catalog_match !== "retired") {
      this.db.prepare("UPDATE users SET deactivated_at = NULL WHERE id = ?").run(local.id);
    }
    this.storeProfile(local.id, person, profile, now);
  }

  private storeProfile(userId: string, person: CatalogPerson, profile: CatalogProfileData | null, now: number) {
    const masks: Record<string, string | null> = {};
    // Маскируем сами, даже если YourSpace уже прислал маску: сырые чувствительные данные не храним.
    for (const field of SENSITIVE_FIELDS) masks[field] = maskValue(field, profile?.[field]);
    const values = {
      user_id: userId,
      username: person.username,
      full_name: person.fullName,
      nickname: person.nickname,
      telegram: person.telegram,
      vk: person.vk,
      city: person.city,
      timezone: person.timezone,
      portfolio: person.portfolio,
      role_title: person.roleTitle,
      membership_status: person.membershipStatus,
      joined_at: person.joinedAt,
      tenure: person.tenure?.text ?? null,
      availability_hours: person.availabilityHours,
      gitea_login: person.giteaLogin,
      perforce_login: person.perforceLogin,
      masks: JSON.stringify(masks),
      revision: person.revision,
      synced_at: now,
    };
    const columns = Object.keys(values);
    this.db
      .prepare(
        `INSERT INTO catalog_profiles (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})
         ON CONFLICT(user_id) DO UPDATE SET ${columns
           .filter((column) => column !== "user_id")
           .map((column) => `${column} = excluded.${column}`)
           .join(", ")}`,
      )
      .run(values);
  }

  /** Профиль каталога для карточки человека. */
  profileOf(userId: string, subject: string | null): CatalogProfile | null {
    const row = this.db.prepare("SELECT * FROM catalog_profiles WHERE user_id = ?").get(userId) as
      | ProfileRow
      | undefined;
    if (!row || !subject) return null;
    const masks = JSON.parse(row.masks) as Record<string, string | null>;
    const status = MEMBERSHIP_STATUSES.includes(row.membership_status as MembershipStatus)
      ? (row.membership_status as MembershipStatus)
      : null;
    return {
      username: row.username,
      fullName: row.full_name,
      nickname: row.nickname,
      telegram: row.telegram,
      vk: row.vk,
      city: row.city,
      timezone: row.timezone,
      portfolio: row.portfolio,
      roleTitle: row.role_title,
      membershipStatus: status,
      joinedAt: row.joined_at,
      tenure: row.tenure,
      availabilityHours: row.availability_hours,
      giteaLogin: row.gitea_login,
      perforceLogin: row.perforce_login,
      masked: {
        phone: masks.phone ?? null,
        extraEmail: masks.extraEmail ?? null,
        birthDate: masks.birthDate ?? null,
        comments: masks.comments ?? null,
        unavailabilityRisk: masks.unavailabilityRisk ?? null,
      },
      profileUrl: this.catalog.profileUrl(subject),
      syncedAt: new Date(row.synced_at).toISOString(),
    };
  }

  // ---- отчёт сопоставления ------------------------------------------------------------------

  report(viewer: UserRow): CatalogReport {
    const rows = this.db
      .prepare(
        `SELECT * FROM users WHERE ${visibleSql(viewer)}
         ORDER BY CASE catalog_match WHEN 'unresolved' THEN 0 ELSE 1 END, name COLLATE NOCASE`,
      )
      .all() as LocalRow[];
    const candidatesPool = this.db
      .prepare(
        `SELECT u.yourspace_subject AS catalogId, u.name, u.email FROM users u
         WHERE u.catalog_match = 'created' AND u.yourspace_subject IS NOT NULL`,
      )
      .all() as { catalogId: string; name: string; email: string | null }[];
    const counts = Object.fromEntries(CATALOG_MATCHES.map((match) => [match, 0])) as Record<CatalogMatch, number>;
    const firstWord = (name: string) => name.trim().split(/\s+/)[0]?.toLocaleLowerCase("ru") ?? "";
    const reportRows: CatalogReportRow[] = rows.map((row) => {
      counts[row.catalog_match] += 1;
      const candidates =
        row.catalog_match === "unresolved"
          ? candidatesPool.filter(
              (candidate) =>
                (row.email !== null && candidate.email === row.email) ||
                firstWord(candidate.name) === firstWord(row.name),
            )
          : [];
      return {
        person: { id: row.id, name: row.name, email: row.email, deactivated: row.deactivated_at !== null },
        match: row.catalog_match,
        catalogId: row.yourspace_subject,
        candidates,
      };
    });
    const lastSync = this.state(LAST_SYNC_KEY);
    return {
      lastSyncAt: lastSync ? new Date(Number(lastSync)).toISOString() : null,
      lastError: this.state(LAST_ERROR_KEY) ?? null,
      counts,
      rows: reportRows,
    };
  }

  /** Суперадмин разбирает строку отчёта: связывает с аккаунтом каталога или отмечает «нет в каталоге». */
  async resolve(
    viewer: UserRow,
    userId: string,
    resolution: { action: "link"; catalogId: string } | { action: "retire" },
  ) {
    const local = this.db.prepare(`SELECT * FROM users WHERE id = ? AND ${visibleSql(viewer)}`).get(userId) as
      | LocalRow
      | undefined;
    if (!local) throw new AppError(404, "not_found", "Person not found");
    if (local.catalog_match !== "unresolved") throw new AppError(409, "conflict", "This row is already resolved");

    if (resolution.action === "retire") {
      this.db
        .prepare("UPDATE users SET catalog_match = 'retired', updated_at = ? WHERE id = ?")
        .run(Date.now(), local.id);
      this.deactivate({ ...local, catalog_match: "retired" }, Date.now());
      return;
    }

    let profile: CatalogProfileData | null;
    try {
      profile = await this.catalog.profile(resolution.catalogId);
    } catch (error) {
      if (error instanceof CatalogError)
        throw new AppError(503, "catalog_unavailable", "YourSpace catalog is unavailable");
      throw error;
    }
    if (!profile) throw new AppError(404, "not_found", "No such person in the YourSpace catalog");
    this.db.transaction(() => {
      const current = this.db.prepare("SELECT * FROM users WHERE id = ?").get(local.id) as LocalRow;
      if (current.catalog_match !== "unresolved") throw new AppError(409, "conflict", "This row is already resolved");
      const created = this.bySubject(resolution.catalogId);
      if (created) {
        if (created.catalog_match !== "created") {
          throw new AppError(409, "conflict", "This catalog account is already matched to another person");
        }
        this.merge(created.id, local.id);
      }
      this.db
        .prepare("UPDATE users SET yourspace_subject = ?, catalog_match = 'manual', updated_at = ? WHERE id = ?")
        .run(resolution.catalogId, Date.now(), local.id);
      const linked = this.bySubject(resolution.catalogId) as LocalRow;
      this.apply(profile, profile);
      // apply() не трогает способ сопоставления у уже связанной строки.
      this.db.prepare("UPDATE users SET catalog_match = 'manual' WHERE id = ?").run(linked.id);
    })();
  }

  /** Переносит участие автоматически созданной строки на заведённую вручную и удаляет дубликат. */
  private merge(fromId: string, toId: string) {
    for (const [table, column] of [
      ["guild_members", "guild_id"],
      ["feature_team_members", "team_id"],
    ] as const) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${table} (${column}, user_id, created_at) SELECT ${column}, ?, created_at FROM ${table} WHERE user_id = ?`,
        )
        .run(toId, fromId);
    }
    this.db
      .prepare("UPDATE OR IGNORE access_grants SET subject_id = ? WHERE subject_kind = 'person' AND subject_id = ?")
      .run(toId, fromId);
    this.db
      .prepare(
        "UPDATE OR IGNORE ticket_visibility_allow SET subject_id = ? WHERE subject_kind = 'person' AND subject_id = ?",
      )
      .run(toId, fromId);
    this.db.prepare("UPDATE guilds SET lead_id = ? WHERE lead_id = ?").run(toId, fromId);
    this.db.prepare("UPDATE feature_teams SET pm_id = ? WHERE pm_id = ?").run(toId, fromId);
    this.db.prepare("DELETE FROM users WHERE id = ?").run(fromId);
  }
}
