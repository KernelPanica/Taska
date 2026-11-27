import { randomUUID } from "node:crypto";
import {
  accessLevel,
  RIGHTS,
  rightAllows,
  type AccessLevel,
  type ProfileRights,
  type Right,
  type ScopeContext,
  type ScopeTicket,
  type StatusCategory,
  type SubjectKind,
  type Visibility,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import type { UserRow } from "../auth/sessions.js";
import { AppError } from "../errors.js";
import { json, placeholders } from "../ticket-types/common.js";

/**
 * Права и видимость (R-2.20, R-5.2, R-3.2; YT-08, docs/adr/0014). Единая проверка для всех точек API:
 * следующие карточки обязаны проверять доступ только через этот сервис.
 */

export const SUPERADMIN_PROFILE = "profile-superadmin";

interface GrantRow {
  id: string;
  subject_kind: SubjectKind;
  subject_id: string | null;
  space_id: string | null;
  branch_id: string | null;
  field_key: string | null;
  field_value: string | null;
  profile_id: string;
  rights: string;
}

interface AppliedGrant {
  profileId: string;
  rights: ProfileRights;
  spaceId: string | null;
  branchId: string | null;
  fieldKey: string | null;
  fieldValue: string | null;
  scope: ScopeContext;
}

export interface ViewerContext {
  userId: string;
  isTest: boolean;
  /** Суперадмин вне «Смотреть как»: видит и может всё. */
  superadmin: boolean;
  grants: AppliedGrant[];
  /** Чем человек допускается к содержимому ограниченного тикета: person:id, team:id, guild:id. */
  allowKeys: Set<string>;
}

/** Факты о тикете, нужные правилам. */
export interface TicketFacts {
  id: string;
  spaceId: string;
  values: Record<string, unknown>;
  scope: ScopeTicket;
  /** Сам тикет и все предки. */
  lineage: Set<string>;
  restrictions: { sourceId: string; visibility: Exclude<Visibility, "open"> }[];
}

export interface TicketAccess {
  level: AccessLevel;
  rights: Set<Right>;
  /** Профили зрителя у этого тикета (для маски полей). */
  profiles: Set<string>;
}

const NONE: TicketAccess = { level: "none", rights: new Set(), profiles: new Set() };
const ALL_RIGHTS = new Set<Right>(RIGHTS);

/** Человеческие объяснения отказов (R-3.3). */
const RIGHT_TEXT: Record<Right, string> = {
  view: "You cannot see this ticket",
  comment: "You cannot comment on this ticket",
  create: "You cannot create tickets here",
  edit: "You can edit the description and fields only in tickets of your team or stream",
  status: "Only the team (or the guild lead for tickets without a team) changes the status of this ticket",
  assign: "Only the team (or the guild lead for tickets without a team) assigns this ticket",
  dates: "Only the team (or the guild lead for tickets without a team) changes the dates of this ticket",
  move: "You cannot move this ticket in the tree",
  trash: "You cannot delete this ticket",
  visibility: "Only a superadmin or a space admin changes the visibility",
  bulk: "You cannot run bulk operations here",
  assistant: "You cannot run the assistant here",
  boards_space: "You cannot configure the boards of this space",
  boards_personal: "You cannot keep personal boards",
  configure: "You cannot configure types, statuses and fields",
  automation: "You cannot manage automation rules",
  wip_override: "You cannot override the WIP limit",
  grant: "You cannot grant rights here",
  org: "Only a superadmin creates spaces and manages the team structure",
  purge: "Only a superadmin deletes for good",
  restore: "You cannot restore this ticket",
  export: "You cannot export here: ask an admin of the space for the «Export» right",
  directory: "You cannot see the people directory",
  tags: "You cannot merge or rename tags",
  frozen: "You cannot change frozen requirements",
};

export function forbidden(right: Right): AppError {
  return new AppError(403, "forbidden", RIGHT_TEXT[right]);
}

export function accessService(db: Database) {
  const ids = (sql: string, ...params: unknown[]) =>
    new Set((db.prepare(sql).all(...params) as { id: string }[]).map((row) => row.id));

  function context(viewer: UserRow): ViewerContext {
    const lens = viewer.lensProfileId ?? null;
    const superadmin = viewer.role === "superadmin" && !lens;
    const memberTeams = ids("SELECT team_id AS id FROM feature_team_members WHERE user_id = ?", viewer.id);
    const memberGuilds = ids("SELECT guild_id AS id FROM guild_members WHERE user_id = ?", viewer.id);
    // ПМ и лид берутся из карточки группы: сменили лида — права переехали сами (R-2.15).
    const pmTeams = ids("SELECT id FROM feature_teams WHERE pm_id = ?", viewer.id);
    const leadGuilds = ids("SELECT id FROM guilds WHERE lead_id = ?", viewer.id);
    const teams = new Set([...memberTeams, ...pmTeams]);
    const guilds = new Set([...memberGuilds, ...leadGuilds]);
    const rows = db
      .prepare(
        `SELECT g.id, g.subject_kind, g.subject_id, g.space_id, g.branch_id, g.field_key, g.field_value, g.profile_id, p.rights
         FROM access_grants g JOIN access_profiles p ON p.id = g.profile_id
         WHERE ${viewer.isTest ? "1 = 1" : "g.is_test = 0"} ${lens ? "AND g.profile_id = ? AND g.subject_kind = 'everyone'" : ""}`,
      )
      .all(...(lens ? [lens] : [])) as GrantRow[];
    const grants: AppliedGrant[] = [];
    for (const row of rows) {
      let scope: ScopeContext | null = null;
      const one = (id: string | null, from: Set<string>) => (id ? (from.has(id) ? new Set([id]) : null) : from);
      switch (row.subject_kind) {
        case "everyone":
          scope = { userId: viewer.id, teams, guilds };
          break;
        case "person":
          if (row.subject_id === viewer.id) scope = { userId: viewer.id, teams, guilds };
          break;
        case "team": {
          const set = one(row.subject_id, teams);
          if (set?.size) scope = { userId: viewer.id, teams: set, guilds };
          break;
        }
        case "guild": {
          const set = one(row.subject_id, guilds);
          if (set?.size) scope = { userId: viewer.id, teams, guilds: set };
          break;
        }
        case "team_pm": {
          const set = one(row.subject_id, pmTeams);
          if (set?.size) scope = { userId: viewer.id, teams: set, guilds };
          break;
        }
        case "guild_lead": {
          const set = one(row.subject_id, leadGuilds);
          if (set?.size) scope = { userId: viewer.id, teams, guilds: set };
          break;
        }
      }
      if (!scope) continue;
      grants.push({
        profileId: row.profile_id,
        rights: json<ProfileRights>(row.rights, {}),
        spaceId: row.space_id,
        branchId: row.branch_id,
        fieldKey: row.field_key,
        fieldValue: row.field_value,
        scope,
      });
    }
    // Под линзой роли зритель — «типичный носитель роли»: личных допусков к скрытым тикетам у него нет.
    const allowKeys = lens
      ? new Set<string>()
      : new Set([
          `person:${viewer.id}`,
          ...[...teams].map((id) => `team:${id}`),
          ...[...guilds].map((id) => `guild:${id}`),
        ]);
    return { userId: viewer.id, isTest: viewer.isTest, superadmin, grants, allowKeys };
  }

  function facts(ticketIds: readonly string[]): Map<string, TicketFacts> {
    const result = new Map<string, TicketFacts>();
    const unique = [...new Set(ticketIds)];
    for (let index = 0; index < unique.length; index += 500) {
      const chunk = unique.slice(index, index + 500);
      const rows = db
        .prepare(
          `SELECT t.id, t.space_id, t.field_values, t.created_by, t.deleted_by, s.category
           FROM tickets t JOIN scheme_statuses s ON s.id = t.status_id WHERE t.id IN (${placeholders(chunk)})`,
        )
        .all(...chunk) as {
        id: string;
        space_id: string;
        field_values: string;
        created_by: string | null;
        deleted_by: string | null;
        category: StatusCategory;
      }[];
      for (const row of rows) {
        const values = json<Record<string, unknown>>(row.field_values, {});
        const team = typeof values.team === "string" ? values.team : null;
        const streams = Array.isArray(values.stream)
          ? values.stream.filter((item): item is string => typeof item === "string")
          : typeof values.stream === "string"
            ? [values.stream]
            : [];
        result.set(row.id, {
          id: row.id,
          spaceId: row.space_id,
          values,
          scope: { team, streams, createdBy: row.created_by, category: row.category, deletedBy: row.deleted_by },
          lineage: new Set([row.id]),
          restrictions: [],
        });
      }
      for (const link of db
        .prepare(
          `SELECT descendant_id AS d, ancestor_id AS a FROM ticket_closure WHERE descendant_id IN (${placeholders(chunk)})`,
        )
        .all(...chunk) as { d: string; a: string }[]) {
        result.get(link.d)?.lineage.add(link.a);
      }
      for (const item of db
        .prepare(
          `SELECT r.ticket_id AS t, r.source_id AS s, src.visibility AS v FROM ticket_restrictions r
           JOIN tickets src ON src.id = r.source_id WHERE r.ticket_id IN (${placeholders(chunk)})`,
        )
        .all(...chunk) as { t: string; s: string; v: Exclude<Visibility, "open"> }[]) {
        result.get(item.t)?.restrictions.push({ sourceId: item.s, visibility: item.v });
      }
    }
    return result;
  }

  function placeMatches(grant: AppliedGrant, ticket: TicketFacts) {
    if (grant.spaceId && grant.spaceId !== ticket.spaceId) return false;
    if (grant.branchId && !ticket.lineage.has(grant.branchId)) return false;
    if (grant.fieldKey) {
      const value = ticket.values[grant.fieldKey];
      const list = Array.isArray(value) ? value : [value];
      if (!list.includes(grant.fieldValue)) return false;
    }
    return true;
  }

  /** Права по выдачам, без учёта видимости. */
  function grantRights(ctx: ViewerContext, ticket: TicketFacts) {
    const rights = new Set<Right>();
    const profiles = new Set<string>();
    for (const grant of ctx.grants) {
      if (!placeMatches(grant, ticket)) continue;
      profiles.add(grant.profileId);
      for (const right of RIGHTS) {
        if (!rights.has(right) && rightAllows(grant.rights, right, grant.scope, ticket.scope)) rights.add(right);
      }
    }
    return { rights, profiles };
  }

  function evaluateMany(viewer: UserRow, ticketIds: readonly string[], ctx = context(viewer)) {
    const result = new Map<string, TicketAccess>();
    const all = facts(ticketIds);
    if (ctx.superadmin) {
      for (const id of all.keys())
        result.set(id, { level: "full", rights: ALL_RIGHTS, profiles: new Set([SUPERADMIN_PROFILE]) });
      return result;
    }
    // Источники ограничений: допуск по списку или по праву «менять видимость» в источнике.
    const sourceIds = new Set<string>();
    for (const item of all.values()) for (const restriction of item.restrictions) sourceIds.add(restriction.sourceId);
    const sources = facts([...sourceIds].filter((id) => !all.has(id)));
    for (const [id, item] of all) sources.set(id, item);
    const allowed = new Map<string, Set<string>>();
    if (sourceIds.size) {
      for (const row of db
        .prepare(
          `SELECT ticket_id AS t, subject_kind || ':' || subject_id AS k FROM ticket_visibility_allow WHERE ticket_id IN (${placeholders([...sourceIds])})`,
        )
        .all(...sourceIds) as { t: string; k: string }[]) {
        allowed.set(row.t, (allowed.get(row.t) ?? new Set()).add(row.k));
      }
    }
    const exemptCache = new Map<string, boolean>();
    const exempt = (sourceId: string) => {
      const cached = exemptCache.get(sourceId);
      if (cached !== undefined) return cached;
      const keys = allowed.get(sourceId);
      const source = sources.get(sourceId);
      const value =
        Boolean(keys && [...keys].some((key) => ctx.allowKeys.has(key))) ||
        Boolean(source && grantRights(ctx, source).rights.has("visibility"));
      exemptCache.set(sourceId, value);
      return value;
    };
    for (const [id, item] of all) {
      const { rights, profiles } = grantRights(ctx, item);
      if (!rights.has("view")) {
        result.set(id, NONE);
        continue;
      }
      const level = accessLevel(
        id,
        item.restrictions.map((restriction) => ({ ...restriction, exempt: exempt(restriction.sourceId) })),
      );
      result.set(id, level === "full" ? { level, rights, profiles } : { level, rights: new Set(), profiles });
    }
    return result;
  }

  const service = {
    context,
    facts,
    evaluateMany,
    evaluate(viewer: UserRow, ticketId: string, ctx?: ViewerContext): TicketAccess {
      return evaluateMany(viewer, [ticketId], ctx).get(ticketId) ?? NONE;
    },

    /** Права в пространстве хотя бы в части тикетов: выдачи на всё пространство или шире. */
    spaceRights(viewer: UserRow, spaceId: string, ctx = context(viewer)): Set<Right> {
      if (ctx.superadmin) return ALL_RIGHTS;
      const rights = new Set<Right>();
      for (const grant of ctx.grants) {
        if (grant.spaceId && grant.spaceId !== spaceId) continue;
        if (grant.branchId) {
          const branch = db.prepare("SELECT space_id FROM tickets WHERE id = ?").get(grant.branchId) as
            | { space_id: string }
            | undefined;
          if (branch?.space_id !== spaceId) continue;
        }
        for (const right of RIGHTS) if (grant.rights[right]?.length) rights.add(right);
      }
      return rights;
    },

    /** Пространства, где зритель видит хотя бы часть тикетов. */
    visibleSpaceIds(viewer: UserRow, ctx = context(viewer)): Set<string> | "all" {
      if (ctx.superadmin) return "all";
      const result = new Set<string>();
      for (const grant of ctx.grants) {
        if (!grant.rights.view?.length) continue;
        if (!grant.spaceId && !grant.branchId) return "all";
        if (grant.spaceId) result.add(grant.spaceId);
        else if (grant.branchId) {
          const branch = db.prepare("SELECT space_id FROM tickets WHERE id = ?").get(grant.branchId) as
            | { space_id: string }
            | undefined;
          if (branch) result.add(branch.space_id);
        }
      }
      return result;
    },

    /**
     * Скрытые маской поля (R-2.20): поле скрыто, если его скрывают все профили зрителя у тикета.
     * Суперадмин видит всё.
     */
    maskedFields(profiles: Set<string>): Set<string> {
      if (profiles.has(SUPERADMIN_PROFILE) || profiles.size === 0) return new Set();
      const rows = db
        .prepare(
          `SELECT f.key, m.profile_id AS profile FROM field_masks m JOIN ticket_fields f ON f.id = m.field_id
           WHERE m.profile_id IN (${placeholders([...profiles])})`,
        )
        .all(...profiles) as { key: string; profile: string }[];
      const byField = new Map<string, Set<string>>();
      for (const row of rows) byField.set(row.key, (byField.get(row.key) ?? new Set()).add(row.profile));
      return new Set([...byField].filter(([, hidden]) => hidden.size === profiles.size).map(([key]) => key));
    },

    /**
     * Пересчитывает действующие ограничения видимости для тикетов и всех их потомков:
     * явная своя видимость важнее унаследованной, иначе — ограничения всех родителей.
     */
    refreshRestrictions(rootIds: readonly string[], topo: (ids: string[]) => string[]) {
      if (rootIds.length === 0) return;
      const subtree = [
        ...new Set(
          (
            db
              .prepare(
                `SELECT DISTINCT descendant_id AS id FROM ticket_closure WHERE ancestor_id IN (${placeholders([...rootIds])})`,
              )
              .all(...rootIds) as { id: string }[]
          ).map((row) => row.id),
        ),
        ...rootIds,
      ];
      const inSet = new Set(subtree);
      const own = new Map(
        (
          db.prepare(`SELECT id, visibility FROM tickets WHERE id IN (${placeholders(subtree)})`).all(...subtree) as {
            id: string;
            visibility: Visibility | null;
          }[]
        ).map((row) => [row.id, row.visibility]),
      );
      const computed = new Map<string, string[]>();
      const parentsOf = db.prepare("SELECT parent_id AS id FROM ticket_parents WHERE child_id = ?");
      const existing = db.prepare("SELECT source_id AS id FROM ticket_restrictions WHERE ticket_id = ?");
      const remove = db.prepare("DELETE FROM ticket_restrictions WHERE ticket_id = ?");
      const insert = db.prepare("INSERT OR IGNORE INTO ticket_restrictions (ticket_id, source_id) VALUES (?, ?)");
      for (const id of topo(subtree)) {
        const visibility = own.get(id) ?? null;
        let list: string[];
        if (visibility === "open") list = [];
        else if (visibility) list = [id];
        else {
          const set = new Set<string>();
          for (const parent of parentsOf.all(id) as { id: string }[]) {
            const fromParent = inSet.has(parent.id)
              ? (computed.get(parent.id) ?? [])
              : (existing.all(parent.id) as { id: string }[]).map((row) => row.id);
            for (const source of fromParent) set.add(source);
          }
          list = [...set];
        }
        computed.set(id, list);
        remove.run(id);
        for (const source of list) insert.run(id, source);
      }
    },

    /** Журнал безопасности (R-3.2): только дописывается. */
    log(actor: UserRow, action: string, detail: Record<string, unknown>) {
      db.prepare(
        "INSERT INTO security_events (id, at, actor_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(randomUUID(), Date.now(), actor.id, actor.name, action, JSON.stringify(detail));
    },
  };
  return service;
}

export type AccessService = ReturnType<typeof accessService>;
