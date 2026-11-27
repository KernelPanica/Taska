import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { PersonRef } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireSuperadmin, requireAuth, type UserRow } from "../auth/sessions.js";
import {
  createdAsTest,
  idListSchema,
  idParams,
  isUniqueViolation,
  nameSchema,
  personRefSchema,
  toPersonRef,
  type PersonRefRow,
  requireVisiblePeople,
  visibleSql,
} from "./common.js";

/**
 * Колодцы и фичекоманды устроены одинаково: название, состав и «глава» —
 * лид у колодца, ПМ у фичекоманды (R-2.14, docs/adr/0008). Один код на оба справочника.
 */
interface GroupKind {
  path: string;
  tag: string;
  title: string;
  table: string;
  membersTable: string;
  groupColumn: string;
  headColumn: string;
  /** Имя поля главы в API: lead | pm. */
  head: "lead" | "pm";
}

export const GUILDS: GroupKind = {
  path: "guilds",
  tag: "guilds",
  title: "Guild",
  table: "guilds",
  membersTable: "guild_members",
  groupColumn: "guild_id",
  headColumn: "lead_id",
  head: "lead",
};

export const FEATURE_TEAMS: GroupKind = {
  path: "feature-teams",
  tag: "feature-teams",
  title: "Feature team",
  table: "feature_teams",
  membersTable: "feature_team_members",
  groupColumn: "team_id",
  headColumn: "pm_id",
  head: "pm",
};

interface GroupRow {
  id: string;
  name: string;
  key: string | null;
  head_id: string | null;
}

/** Системное имя для TQL: латиница, цифры, «_» и «-», с буквы (R-5.3, docs/adr/0021). */
const KEY_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,39}$";

type Group = { id: string; name: string; members: PersonRef[] } & Record<string, unknown>;

export function groupService(db: Database, kind: GroupKind) {
  const { table, membersTable, groupColumn, headColumn, head } = kind;

  function hydrate(viewer: UserRow, rows: GroupRow[]): Group[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => "?").join(",");
    const members = db
      .prepare(
        `SELECT m.${groupColumn} AS groupId, u.id, u.name, u.email, u.deactivated_at IS NOT NULL AS deactivated FROM ${membersTable} m
         JOIN users u ON u.id = m.user_id
         WHERE m.${groupColumn} IN (${marks}) AND ${visibleSql(viewer, "u.is_test")}
         ORDER BY u.name COLLATE NOCASE`,
      )
      .all(...ids) as (PersonRefRow & { groupId: string })[];
    const heads = new Map(
      (
        db
          .prepare(
            `SELECT id, name, email, deactivated_at IS NOT NULL AS deactivated FROM users WHERE id IN (SELECT ${headColumn} FROM ${table} WHERE id IN (${marks}))`,
          )
          .all(...ids) as PersonRefRow[]
      ).map((person) => [person.id, toPersonRef(person)]),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      key: row.key,
      [head]: row.head_id ? (heads.get(row.head_id) ?? null) : null,
      members: members.filter((member) => member.groupId === row.id).map(toPersonRef),
    }));
  }

  const select = `SELECT id, name, key, ${headColumn} AS head_id FROM ${table}`;

  return {
    list(viewer: UserRow) {
      return hydrate(
        viewer,
        db.prepare(`${select} WHERE ${visibleSql(viewer)} ORDER BY name COLLATE NOCASE`).all() as GroupRow[],
      );
    },
    get(viewer: UserRow, id: string) {
      const row = db.prepare(`${select} WHERE id = ? AND ${visibleSql(viewer)}`).get(id) as GroupRow | undefined;
      if (!row) throw new AppError(404, "not_found", `${kind.title} not found`);
      return hydrate(viewer, [row])[0] as Group;
    },
    create(
      viewer: UserRow,
      input: { name: string; key?: string | null; headId?: string | null; memberIds?: string[] },
    ) {
      const id = randomUUID();
      const now = Date.now();
      const headId = input.headId ? requireVisiblePeople(db, viewer, [input.headId], `${head}Id`)[0] : null;
      const members = requireVisiblePeople(db, viewer, input.memberIds ?? [], "memberIds");
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO ${table} (id, name, key, ${headColumn}, is_test, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(id, input.name.trim(), input.key?.trim() || null, headId ?? null, createdAsTest(viewer), now, now);
          setMembers(id, members, now);
        })();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, "conflict", `${kind.title} with this name or system name already exists`);
        throw error;
      }
      return this.get(viewer, id);
    },
    update(
      viewer: UserRow,
      id: string,
      input: { name?: string; key?: string | null; headId?: string | null; memberIds?: string[] },
    ) {
      this.get(viewer, id);
      const now = Date.now();
      const headId =
        input.headId === undefined || input.headId === null
          ? input.headId
          : requireVisiblePeople(db, viewer, [input.headId], `${head}Id`)[0];
      const members = input.memberIds ? requireVisiblePeople(db, viewer, input.memberIds, "memberIds") : undefined;
      try {
        db.transaction(() => {
          if (input.name !== undefined)
            db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(input.name.trim(), id);
          if (input.key !== undefined)
            db.prepare(`UPDATE ${table} SET key = ? WHERE id = ?`).run(input.key?.trim() || null, id);
          if (headId !== undefined) db.prepare(`UPDATE ${table} SET ${headColumn} = ? WHERE id = ?`).run(headId, id);
          if (members) {
            // Невидимых зрителю участников (тестовых) не трогаем.
            db.prepare(
              `DELETE FROM ${membersTable} WHERE ${groupColumn} = ? AND user_id IN (SELECT id FROM users WHERE ${visibleSql(viewer)})`,
            ).run(id);
            setMembers(id, members, now);
          }
          db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(now, id);
        })();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, "conflict", `${kind.title} with this name or system name already exists`);
        throw error;
      }
      return this.get(viewer, id);
    },
    remove(viewer: UserRow, id: string) {
      this.get(viewer, id);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    },
  };

  function setMembers(groupId: string, userIds: readonly string[], now: number) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${membersTable} (${groupColumn}, user_id, created_at) VALUES (?, ?, ?)`,
    );
    for (const userId of userIds) insert.run(groupId, userId, now);
  }
}

export function groupRoutes(kind: GroupKind): FastifyPluginAsync<{ db: Database }> {
  return async (app, { db }) => {
    const service = groupService(db, kind);
    const headId = `${kind.head}Id`;
    const groupSchema = {
      type: "object",
      required: ["id", "name", kind.head, "members"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        key: { type: ["string", "null"], description: "Latin system name for TQL: team = Frogs" },
        [kind.head]: { anyOf: [personRefSchema, { type: "null" }] },
        members: { type: "array", items: personRefSchema },
      },
    };
    const inputProperties = {
      name: nameSchema,
      key: { anyOf: [{ type: "null" }, { type: "string", maxLength: 0 }, { type: "string", pattern: KEY_PATTERN }] },
      [headId]: { type: ["string", "null"], maxLength: 64 },
      memberIds: idListSchema,
    };
    const base = `/api/v1/${kind.path}`;
    const write = (body: Record<string, unknown>) => ({
      ...(body.name === undefined ? {} : { name: body.name as string }),
      ...(body.key === undefined ? {} : { key: body.key as string | null }),
      ...(body[headId] === undefined ? {} : { headId: body[headId] as string | null }),
      ...(body.memberIds === undefined ? {} : { memberIds: body.memberIds as string[] }),
    });

    app.get(
      base,
      {
        schema: {
          tags: [kind.tag],
          summary: `List ${kind.path}`,
          response: {
            200: { type: "object", required: ["items"], properties: { items: { type: "array", items: groupSchema } } },
            ...problemResponses,
          },
        },
      },
      async (request) => ({ items: service.list(requireAuth(request).user) }),
    );
    app.get(
      `${base}/:id`,
      {
        schema: {
          tags: [kind.tag],
          summary: `${kind.title} card`,
          params: idParams,
          response: { 200: groupSchema, ...problemResponses },
        },
      },
      async (request) => service.get(requireAuth(request).user, (request.params as { id: string }).id),
    );
    app.post(
      base,
      {
        schema: {
          tags: [kind.tag],
          summary: `Create a ${kind.title.toLowerCase()} (superadmin)`,
          body: { type: "object", additionalProperties: false, required: ["name"], properties: inputProperties },
          response: { 201: groupSchema, ...problemResponses },
        },
      },
      async (request, reply) => {
        const { user } = requireSuperadmin(request);
        const group = service.create(user, write(request.body as Record<string, unknown>) as { name: string });
        request.log.info({ adminId: user.id, [kind.table]: group.id }, `${kind.title} created`);
        return reply.code(201).send(group);
      },
    );
    app.patch(
      `${base}/:id`,
      {
        schema: {
          tags: [kind.tag],
          summary: `Update name, ${kind.head} or members (superadmin)`,
          params: idParams,
          body: { type: "object", additionalProperties: false, minProperties: 1, properties: inputProperties },
          response: { 200: groupSchema, ...problemResponses },
        },
      },
      async (request) => {
        const { user } = requireSuperadmin(request);
        return service.update(
          user,
          (request.params as { id: string }).id,
          write(request.body as Record<string, unknown>),
        );
      },
    );
    app.delete(
      `${base}/:id`,
      {
        schema: {
          tags: [kind.tag],
          summary: `Delete a ${kind.title.toLowerCase()} (superadmin)`,
          params: idParams,
          response: { 204: { type: "null" }, ...problemResponses },
        },
      },
      async (request, reply) => {
        const { user } = requireSuperadmin(request);
        service.remove(user, (request.params as { id: string }).id);
        return reply.code(204).send();
      },
    );
  };
}
