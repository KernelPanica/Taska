import type { FastifyPluginAsync } from "fastify";
import {
  LOCALES,
  MEMBERSHIP_STATUSES,
  type GroupRef,
  type Locale,
  type Person,
  type PersonInput,
} from "@yourtask/contracts";
import type { CatalogSync } from "../catalog/sync.js";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireSuperadmin, requireAuth, type UserRow } from "../auth/sessions.js";
import { groupRefSchema, idListSchema, idParams, visibleSql } from "./common.js";

/**
 * Люди (R-2.2, R-2.15, docs/adr/0009). Человека заводят и деактивируют в общем каталоге YourSpace;
 * сюда он приходит синхронизацией. YourTask ведёт только язык, норму WIP, колодцы и фичекоманды.
 */
interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  locale: Locale;
  role: "superadmin" | "member";
  wip_limit: number | null;
  yourspace_subject: string | null;
  deactivated_at: number | null;
}

type PersonPatch = PersonInput;

const nullableString = { type: ["string", "null"] } as const;
const catalogProfileSchema = {
  type: ["object", "null"],
  required: ["username", "masked", "profileUrl", "syncedAt"],
  properties: {
    username: { type: "string" },
    fullName: nullableString,
    nickname: nullableString,
    telegram: nullableString,
    vk: nullableString,
    city: nullableString,
    timezone: nullableString,
    portfolio: nullableString,
    roleTitle: nullableString,
    membershipStatus: { type: ["string", "null"], enum: [...MEMBERSHIP_STATUSES, null] },
    joinedAt: nullableString,
    tenure: nullableString,
    availabilityHours: { type: ["integer", "null"] },
    giteaLogin: nullableString,
    perforceLogin: nullableString,
    masked: {
      type: "object",
      description: "Sensitive fields (R-2.2) are only ever returned masked, for every viewer.",
      required: ["phone", "extraEmail", "birthDate", "comments", "unavailabilityRisk"],
      properties: {
        phone: nullableString,
        extraEmail: nullableString,
        birthDate: nullableString,
        comments: nullableString,
        unavailabilityRisk: nullableString,
      },
    },
    profileUrl: { type: "string" },
    syncedAt: { type: "string", format: "date-time" },
  },
} as const;

const personSchema = {
  type: "object",
  required: [
    "id",
    "name",
    "email",
    "locale",
    "role",
    "wipLimit",
    "linked",
    "deactivated",
    "deactivatedAt",
    "guilds",
    "teams",
    "catalog",
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: nullableString,
    locale: { type: "string", enum: LOCALES },
    role: { type: "string", enum: ["superadmin", "member"] },
    wipLimit: { type: ["integer", "null"] },
    linked: { type: "boolean" },
    deactivated: { type: "boolean" },
    deactivatedAt: { type: ["string", "null"], format: "date-time" },
    guilds: { type: "array", items: groupRefSchema },
    teams: { type: "array", items: groupRefSchema },
    catalog: catalogProfileSchema,
  },
} as const;

const inputProperties = {
  locale: { type: "string", enum: LOCALES },
  wipLimit: { type: ["integer", "null"], minimum: 0, maximum: 1000 },
  guildIds: idListSchema,
  teamIds: idListSchema,
} as const;

export function peopleService(db: Database, catalog: CatalogSync) {
  function groupsOf(viewer: UserRow, ids: string[], table: string, members: string, column: string) {
    if (ids.length === 0) return new Map<string, GroupRef[]>();
    const marks = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT m.user_id AS userId, g.id, g.name FROM ${members} m JOIN ${table} g ON g.id = m.${column}
         WHERE m.user_id IN (${marks}) AND ${visibleSql(viewer, "g.is_test")} ORDER BY g.name COLLATE NOCASE`,
      )
      .all(...ids) as (GroupRef & { userId: string })[];
    const map = new Map<string, GroupRef[]>();
    for (const { userId, id, name } of rows) map.set(userId, [...(map.get(userId) ?? []), { id, name }]);
    return map;
  }

  function hydrate(viewer: UserRow, rows: PersonRow[]): Person[] {
    const ids = rows.map((row) => row.id);
    const guilds = groupsOf(viewer, ids, "guilds", "guild_members", "guild_id");
    const teams = groupsOf(viewer, ids, "feature_teams", "feature_team_members", "team_id");
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      locale: row.locale,
      role: row.role,
      wipLimit: row.wip_limit,
      linked: row.yourspace_subject !== null,
      deactivated: row.deactivated_at !== null,
      deactivatedAt: row.deactivated_at === null ? null : new Date(row.deactivated_at).toISOString(),
      guilds: guilds.get(row.id) ?? [],
      teams: teams.get(row.id) ?? [],
      catalog: catalog.profileOf(row.id, row.yourspace_subject),
    }));
  }

  /** Проверяет, что все колодцы/команды существуют и видны зрителю. */
  function requireGroups(viewer: UserRow, table: string, ids: readonly string[], field: string) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return unique;
    const found = db
      .prepare(`SELECT id FROM ${table} WHERE id IN (${unique.map(() => "?").join(",")}) AND ${visibleSql(viewer)}`)
      .all(...unique) as { id: string }[];
    if (found.length !== unique.length) {
      throw new AppError(400, "validation_failed", "Unknown group", [{ field, message: "contains an unknown id" }]);
    }
    return unique;
  }

  function replaceMemberships(viewer: UserRow, userId: string, patch: PersonPatch, now: number) {
    const sets = [
      { ids: patch.guildIds, table: "guilds", members: "guild_members", column: "guild_id", field: "guildIds" },
      {
        ids: patch.teamIds,
        table: "feature_teams",
        members: "feature_team_members",
        column: "team_id",
        field: "teamIds",
      },
    ];
    for (const set of sets) {
      if (!set.ids) continue;
      const ids = requireGroups(viewer, set.table, set.ids, set.field);
      db.prepare(
        `DELETE FROM ${set.members} WHERE user_id = ? AND ${set.column} IN (SELECT id FROM ${set.table} WHERE ${visibleSql(viewer)})`,
      ).run(userId);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO ${set.members} (${set.column}, user_id, created_at) VALUES (?, ?, ?)`,
      );
      for (const id of ids) insert.run(id, userId, now);
    }
  }

  const select =
    "SELECT u.id, u.name, u.email, u.locale, u.role, u.wip_limit, u.yourspace_subject, u.deactivated_at, p.telegram, p.username FROM users u LEFT JOIN catalog_profiles p ON p.user_id = u.id";

  const service = {
    /** По умолчанию — только активные: их можно назначать. Деактивированные — по includeDeactivated. */
    list(viewer: UserRow, query?: string, includeDeactivated = false) {
      // SQLite lower() не понижает кириллицу, поэтому ищем в JS (справочник небольшой).
      const search = query?.trim().toLocaleLowerCase("ru");
      const rows = (
        db
          .prepare(
            `${select} WHERE ${visibleSql(viewer, "u.is_test")} ${includeDeactivated ? "" : "AND u.deactivated_at IS NULL"}
             ORDER BY u.name COLLATE NOCASE LIMIT 5000`,
          )
          .all() as (PersonRow & { telegram: string | null; username: string | null })[]
      ).filter(
        (row) =>
          !search ||
          [row.name, row.email, row.telegram, row.username]
            .filter(Boolean)
            .join("\n")
            .toLocaleLowerCase("ru")
            .includes(search),
      );
      return hydrate(viewer, rows.slice(0, 1000));
    },
    get(viewer: UserRow, id: string): Person {
      const row = db.prepare(`${select} WHERE u.id = ? AND ${visibleSql(viewer, "u.is_test")}`).get(id) as
        | PersonRow
        | undefined;
      if (!row) throw new AppError(404, "not_found", "Person not found");
      return hydrate(viewer, [row])[0] as Person;
    },
    update(viewer: UserRow, id: string, patch: PersonPatch) {
      service.get(viewer, id);
      const now = Date.now();
      db.transaction(() => {
        const fields: [string, unknown][] = [];
        if (patch.locale !== undefined) fields.push(["locale", patch.locale]);
        if (patch.wipLimit !== undefined) fields.push(["wip_limit", patch.wipLimit]);
        fields.push(["updated_at", now]);
        db.prepare(`UPDATE users SET ${fields.map(([name]) => `${name} = ?`).join(", ")} WHERE id = ?`).run(
          ...fields.map(([, value]) => value),
          id,
        );
        replaceMemberships(viewer, id, patch, now);
      })();
      return service.get(viewer, id);
    },
  };
  return service;
}

export const peopleRoutes: FastifyPluginAsync<{ db: Database; catalog: CatalogSync }> = async (
  app,
  { db, catalog },
) => {
  const people = peopleService(db, catalog);

  app.get(
    "/api/v1/people",
    {
      schema: {
        tags: ["people"],
        summary: "People from the YourSpace catalog",
        description:
          "Active people by default — they can be assigned. People are added and deactivated in the YourSpace catalog (R-2.2).",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: 100 },
            includeDeactivated: { type: "boolean", default: false },
          },
        },
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: personSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const query = request.query as { q?: string; includeDeactivated: boolean };
      return { items: people.list(requireAuth(request).user, query.q, query.includeDeactivated) };
    },
  );

  app.get(
    "/api/v1/people/:id",
    {
      schema: {
        tags: ["people"],
        summary: "Person card: catalog profile (sensitive fields masked) and YourTask data",
        params: idParams,
        response: { 200: personSchema, ...problemResponses },
      },
    },
    async (request) => people.get(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.patch(
    "/api/v1/people/:id",
    {
      schema: {
        tags: ["people"],
        summary: "Update what YourTask keeps: language, WIP limit, guilds and feature teams (superadmin)",
        description: "Name, email and other profile fields are edited in the YourSpace profile.",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          // Явный отказ вместо молчаливого удаления: имя и почта правятся только в YourSpace.
          properties: { ...inputProperties, name: false, email: false },
        },
        response: { 200: personSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return people.update(user, (request.params as { id: string }).id, request.body as PersonPatch);
    },
  );
};
