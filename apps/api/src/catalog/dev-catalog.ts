import { randomUUID } from "node:crypto";
import type { Locale } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { testAccounts, testCatalogPeople } from "../testing/accounts.js";
import {
  maskValue,
  type Catalog,
  type CatalogEvent,
  type CatalogEventType,
  type CatalogPerson,
  type CatalogProfileData,
  type CatalogRole,
} from "./catalog.js";

/**
 * Каталог YourSpace внутри заглушки для разработки и автотестов (только профили development/test).
 * Ведёт себя как настоящий: люди, маски, лента событий. Хранится в своих таблицах `dev_yourspace_*`,
 * которые создаёт сама заглушка: в production их нет.
 */
export interface DevAccount {
  id: string;
  login: string;
  email: string | null;
  fullName: string;
  locale: Locale;
  role: CatalogRole;
  active: boolean;
  deactivatedAt: number | null;
  telegram: string | null;
  phone: string | null;
  birthDate: string | null;
  google: string | null;
  otp: string | null;
  revision: number;
  createdAt: number;
}

interface AccountRow {
  id: string;
  login: string;
  email: string | null;
  full_name: string;
  locale: Locale;
  role: CatalogRole;
  active: number;
  deactivated_at: number | null;
  telegram: string | null;
  phone: string | null;
  birth_date: string | null;
  google: string | null;
  otp: string | null;
  revision: number;
  created_at: number;
}

export interface DevAccountInput {
  login: string;
  fullName: string;
  email?: string | null;
  telegram?: string | null;
  phone?: string | null;
  birthDate?: string | null;
}

export class DevCatalogError extends Error {
  override name = "DevCatalogError";
}

const toAccount = (row: AccountRow): DevAccount => ({
  id: row.id,
  login: row.login,
  email: row.email,
  fullName: row.full_name,
  locale: row.locale,
  role: row.role,
  active: row.active === 1,
  deactivatedAt: row.deactivated_at,
  telegram: row.telegram,
  phone: row.phone,
  birthDate: row.birth_date,
  google: row.google,
  otp: row.otp,
  revision: row.revision,
  createdAt: row.created_at,
});

const clean = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export class DevCatalog implements Catalog {
  readonly kind = "dev" as const;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dev_yourspace_accounts (
        id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, email TEXT, full_name TEXT NOT NULL,
        locale TEXT NOT NULL DEFAULT 'ru', role TEXT NOT NULL DEFAULT 'member', active INTEGER NOT NULL DEFAULT 1,
        deactivated_at INTEGER, telegram TEXT, phone TEXT, birth_date TEXT, google TEXT, otp TEXT,
        revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dev_yourspace_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    this.seed();
  }

  private seed() {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO dev_yourspace_accounts (id, login, email, full_name, locale, role, telegram, phone, birth_date, google, otp, created_at)
       VALUES (@id, @login, @email, @fullName, @locale, @role, @telegram, @phone, @birthDate, @google, @otp, @createdAt)`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const account of [...testAccounts, ...testCatalogPeople]) {
        const added = insert.run({
          id: account.subject,
          login: account.login,
          email: account.email,
          fullName: account.name,
          locale: account.locale,
          role: account.role,
          telegram: account.telegram,
          phone: account.phone,
          birthDate: account.birthDate,
          google: account.google,
          otp: account.otp,
          createdAt: now,
        });
        if (added.changes) this.event(account.subject, "created", now);
      }
    })();
  }

  private event(userId: string, type: CatalogEventType, now = Date.now()) {
    this.db
      .prepare("INSERT INTO dev_yourspace_events (user_id, type, created_at) VALUES (?, ?, ?)")
      .run(userId, type, now);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Подписка на изменения: в разработке синхронизация срабатывает сразу, без ожидания опроса. */
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  accounts(): DevAccount[] {
    return (
      this.db.prepare("SELECT * FROM dev_yourspace_accounts ORDER BY full_name COLLATE NOCASE").all() as AccountRow[]
    ).map(toAccount);
  }

  account(id: string): DevAccount | undefined {
    const row = this.db.prepare("SELECT * FROM dev_yourspace_accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  findByLogin(login: string) {
    const row = this.db
      .prepare("SELECT * FROM dev_yourspace_accounts WHERE login = ? AND active = 1")
      .get(login.trim().toLowerCase()) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  findByGoogle(google: string) {
    const row = this.db.prepare("SELECT * FROM dev_yourspace_accounts WHERE google = ? AND active = 1").get(google) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : undefined;
  }

  linkedGoogleAccounts() {
    return this.accounts().filter((account) => account.active && account.google !== null);
  }

  create(input: DevAccountInput): DevAccount {
    const login = input.login.trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(login)) throw new DevCatalogError("Логин: латиница, цифры, точка, дефис");
    if (!input.fullName.trim()) throw new DevCatalogError("Укажите ФИО");
    if (this.db.prepare("SELECT 1 FROM dev_yourspace_accounts WHERE login = ?").get(login)) {
      throw new DevCatalogError("Такой логин уже есть");
    }
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO dev_yourspace_accounts (id, login, email, full_name, telegram, phone, birth_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        login,
        clean(input.email)?.toLowerCase() ?? null,
        input.fullName.trim(),
        clean(input.telegram),
        clean(input.phone),
        clean(input.birthDate),
        now,
      );
    this.event(id, "created", now);
    this.changed();
    return this.account(id) as DevAccount;
  }

  update(id: string, patch: Partial<Omit<DevAccountInput, "login">>) {
    const current = this.account(id);
    if (!current) throw new DevCatalogError("Нет такого человека");
    const next = {
      full_name: patch.fullName !== undefined ? patch.fullName.trim() || current.fullName : current.fullName,
      email: patch.email !== undefined ? (clean(patch.email)?.toLowerCase() ?? null) : current.email,
      telegram: patch.telegram !== undefined ? clean(patch.telegram) : current.telegram,
      phone: patch.phone !== undefined ? clean(patch.phone) : current.phone,
      birth_date: patch.birthDate !== undefined ? clean(patch.birthDate) : current.birthDate,
    };
    this.db
      .prepare(
        `UPDATE dev_yourspace_accounts SET full_name = @full_name, email = @email, telegram = @telegram, phone = @phone,
         birth_date = @birth_date, revision = revision + 1 WHERE id = @id`,
      )
      .run({ ...next, id });
    this.event(id, "updated");
    this.changed();
  }

  setActive(id: string, active: boolean) {
    const current = this.account(id);
    if (!current) throw new DevCatalogError("Нет такого человека");
    if (current.active === active) return;
    this.db
      .prepare("UPDATE dev_yourspace_accounts SET active = ?, deactivated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(active ? 1 : 0, active ? null : Date.now(), id);
    this.event(id, active ? "reactivated" : "deactivated");
    this.changed();
  }

  private summary(account: DevAccount): CatalogPerson {
    return {
      id: account.id,
      username: account.login,
      displayName: account.fullName,
      role: account.role,
      active: account.active,
      deactivatedAt: account.deactivatedAt,
      contactEmail: account.email,
      fullName: account.fullName,
      nickname: null,
      telegram: account.telegram,
      vk: null,
      city: null,
      timezone: null,
      portfolio: null,
      giteaLogin: null,
      perforceLogin: null,
      availabilityHours: null,
      roleTitle: null,
      joinedAt: null,
      membershipStatus: account.active ? "active" : "left",
      tenure: null,
      revision: account.revision,
    };
  }

  async list() {
    return this.accounts().map((account) => this.summary(account));
  }

  async profile(id: string): Promise<CatalogProfileData | null> {
    const account = this.account(id);
    if (!account) return null;
    const sensitive = { phone: account.phone, birthDate: account.birthDate };
    return {
      ...this.summary(account),
      phone: maskValue("phone", sensitive.phone),
      birthDate: maskValue("birthDate", sensitive.birthDate),
      extraEmail: null,
      comments: null,
      unavailabilityRisk: null,
      masked: Object.entries(sensitive)
        .filter(([, value]) => value !== null)
        .map(([key]) => key),
    };
  }

  async events(after: number) {
    const items = this.db
      .prepare(
        "SELECT id, user_id AS userId, type, created_at AS createdAt FROM dev_yourspace_events WHERE id > ? ORDER BY id LIMIT 500",
      )
      .all(after) as CatalogEvent[];
    return { items, next: items.at(-1)?.id ?? after };
  }

  profileUrl(id: string) {
    return `/dev/yourspace/people/${encodeURIComponent(id)}`;
  }
}
