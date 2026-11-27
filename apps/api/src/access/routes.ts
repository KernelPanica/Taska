import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  RIGHT_SCOPES,
  RIGHTS,
  SUBJECT_KINDS,
  type AccessGrant,
  type AccessGrantInput,
  type AccessProfile,
  type ProfileRights,
  type SecurityEvent,
  type SubjectKind,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type Auth, type SessionStore, type UserRow } from "../auth/sessions.js";
import { idParams, isUniqueViolation, nameSchema } from "../directory/common.js";
import { json, systemKey } from "../ticket-types/common.js";
import { accessService, forbidden } from "./service.js";

/**
 * API прав (R-2.20, R-5.2; YT-08, docs/adr/0014): профили и конструктор, выдачи «кто × где × профиль»,
 * маска полей, «Смотреть как» и «Режим показа», журнал безопасности.
 */
const rightsSchema = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    RIGHTS.map((right) => [
      right,
      {
        type: "array",
        maxItems: RIGHT_SCOPES.length,
        uniqueItems: true,
        items: { type: "string", enum: RIGHT_SCOPES },
      },
    ]),
  ),
} as const;

const profileSchema = {
  type: "object",
  required: ["id", "key", "name", "rights", "system", "grants"],
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    rights: rightsSchema,
    system: { type: "boolean" },
    grants: { type: "integer" },
  },
} as const;

const looseObject = { type: "object", additionalProperties: true } as const;

const grantBody = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "place", "profileId"],
  properties: {
    subject: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: {
        kind: { type: "string", enum: SUBJECT_KINDS },
        id: { anyOf: [{ type: "null" }, { type: "string", maxLength: 64 }] },
      },
    },
    place: {
      type: "object",
      additionalProperties: false,
      required: ["spaceId", "branchKey", "fieldKey", "fieldValue"],
      properties: {
        spaceId: { anyOf: [{ type: "null" }, { type: "string", maxLength: 64 }] },
        branchKey: { anyOf: [{ type: "null" }, { type: "string", maxLength: 40 }] },
        fieldKey: { anyOf: [{ type: "null" }, { type: "string", maxLength: 60 }] },
        fieldValue: { anyOf: [{ type: "null" }, { type: "string", maxLength: 120 }] },
      },
    },
    profileId: { type: "string", maxLength: 64 },
  },
} as const;

interface ProfileRow {
  id: string;
  key: string;
  name: string;
  rights: string;
  is_system: number;
  grants: number;
}

interface GrantRow {
  id: string;
  subject_kind: SubjectKind;
  subject_id: string | null;
  subject_name: string | null;
  space_id: string | null;
  space_name: string | null;
  branch_key: string | null;
  branch_title: string | null;
  field_key: string | null;
  field_value: string | null;
  field_value_name: string | null;
  profile_id: string;
  profile_name: string;
  created_at: number;
}

export const accessRoutes: FastifyPluginAsync<{ db: Database; sessions: SessionStore }> = async (
  app,
  { db, sessions },
) => {
  const access = accessService(db);

  const testScope = (viewer: UserRow, column: string) => (viewer.isTest ? "1 = 1" : `${column} = 0`);

  function profiles(viewer: UserRow, where = "1 = 1", ...params: unknown[]): AccessProfile[] {
    return (
      db
        .prepare(
          `SELECT p.id, p.key, p.name, p.rights, p.is_system,
             (SELECT count(*) FROM access_grants g WHERE g.profile_id = p.id) AS grants
           FROM access_profiles p WHERE ${testScope(viewer, "p.is_test")} AND ${where}
           ORDER BY p.is_system DESC, p.created_at, p.name COLLATE NOCASE`,
        )
        .all(...params) as ProfileRow[]
    ).map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      rights: json<ProfileRights>(row.rights, {}),
      system: row.is_system === 1,
      grants: row.grants,
    }));
  }

  function profile(viewer: UserRow, id: string) {
    const found = profiles(viewer, "p.id = ?", id)[0];
    if (!found) throw new AppError(404, "not_found", "Profile not found");
    return found;
  }

  /** Пустые списки областей не храним: право без областей — нет права. */
  const cleanRights = (rights: ProfileRights): ProfileRights =>
    Object.fromEntries(Object.entries(rights).filter(([, scopes]) => scopes?.length)) as ProfileRights;

  function grants(viewer: UserRow, where = "1 = 1", ...params: unknown[]): AccessGrant[] {
    return (
      db
        .prepare(
          `SELECT g.id, g.subject_kind, g.subject_id,
             CASE g.subject_kind WHEN 'person' THEN u.name WHEN 'team' THEN ft.name WHEN 'team_pm' THEN ft.name
               WHEN 'guild' THEN gu.name WHEN 'guild_lead' THEN gu.name END AS subject_name,
             g.space_id, s.name AS space_name, b.key AS branch_key, b.title AS branch_title,
             g.field_key, g.field_value, coalesce(vft.name, vgu.name, vo.label, g.field_value) AS field_value_name,
             g.profile_id, p.name AS profile_name, g.created_at
           FROM access_grants g JOIN access_profiles p ON p.id = g.profile_id
           LEFT JOIN users u ON u.id = g.subject_id
           LEFT JOIN feature_teams ft ON ft.id = g.subject_id
           LEFT JOIN guilds gu ON gu.id = g.subject_id
           LEFT JOIN spaces s ON s.id = g.space_id
           LEFT JOIN tickets b ON b.id = g.branch_id
           LEFT JOIN feature_teams vft ON vft.id = g.field_value
           LEFT JOIN guilds vgu ON vgu.id = g.field_value
           LEFT JOIN dimension_options vo ON vo.id = g.field_value
           WHERE ${testScope(viewer, "g.is_test")} AND ${where}
           ORDER BY s.name COLLATE NOCASE, g.created_at`,
        )
        .all(...params) as GrantRow[]
    ).map((row) => ({
      id: row.id,
      subject: { kind: row.subject_kind, id: row.subject_id, name: row.subject_name },
      place: {
        spaceId: row.space_id,
        spaceName: row.space_name,
        branchKey: row.branch_key,
        branchTitle: row.branch_title,
        fieldKey: row.field_key,
        fieldValue: row.field_value,
        fieldValueName: row.field_value_name,
      },
      profileId: row.profile_id,
      profileName: row.profile_name,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  /** Выдавать права: суперадмин — везде, обладатель права «выдавать» — в своём пространстве (R-5.2). */
  function requireGrantRight(request: FastifyRequest, spaceId: string | null): Auth {
    const auth = requireAuth(request);
    if (auth.user.role === "superadmin") return requireSuperadmin(request);
    if (!spaceId || !access.spaceRights(auth.user, spaceId).has("grant")) throw forbidden("grant");
    return auth;
  }

  // ---- профили ----

  app.get(
    "/api/v1/access/profiles",
    {
      schema: {
        tags: ["access"],
        summary: "Rights profiles: six starter ones from R-5.2 and profiles built in the constructor",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: profileSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: profiles(requireAuth(request).user) }),
  );

  app.post(
    "/api/v1/access/profiles",
    {
      schema: {
        tags: ["access"],
        summary: "Build a profile in the constructor or copy one (superadmin)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "rights"],
          properties: { name: nameSchema, key: { type: "string", maxLength: 60 }, rights: rightsSchema },
        },
        response: { 201: profileSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user, realUser } = requireSuperadmin(request);
      const body = request.body as { name: string; key?: string; rights: ProfileRights };
      const id = randomUUID();
      const key = systemKey(body.name, body.key, "profile");
      const now = Date.now();
      try {
        db.prepare(
          "INSERT INTO access_profiles (id, key, name, rights, is_system, is_test, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
        ).run(id, key, body.name.trim(), JSON.stringify(cleanRights(body.rights)), user.isTest ? 1 : 0, now, now);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError(409, "conflict", `Profile key "${key}" is already used`);
        throw error;
      }
      access.log(realUser, "profile.create", { id, name: body.name, rights: body.rights });
      return reply.code(201).send(profile(user, id));
    },
  );

  app.patch(
    "/api/v1/access/profiles/:id",
    {
      schema: {
        tags: ["access"],
        summary: "Change a profile; starter profiles can be edited too (superadmin)",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, rights: rightsSchema },
        },
        response: { 200: profileSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user, realUser } = requireSuperadmin(request);
      const { id } = request.params as { id: string };
      const current = profile(user, id);
      const body = request.body as { name?: string; rights?: ProfileRights };
      db.prepare("UPDATE access_profiles SET name = ?, rights = ?, updated_at = ? WHERE id = ?").run(
        body.name?.trim() ?? current.name,
        JSON.stringify(body.rights ? cleanRights(body.rights) : current.rights),
        Date.now(),
        id,
      );
      access.log(realUser, "profile.update", { id, before: current.rights, after: body.rights ?? current.rights });
      return profile(user, id);
    },
  );

  app.delete(
    "/api/v1/access/profiles/:id",
    {
      schema: {
        tags: ["access"],
        summary: "Delete a profile built in the constructor that nobody uses (superadmin)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user, realUser } = requireSuperadmin(request);
      const current = profile(user, (request.params as { id: string }).id);
      if (current.system) throw new AppError(409, "conflict", "Starter profiles are edited, not deleted");
      if (current.grants > 0) {
        throw new AppError(409, "conflict", `The profile is used in ${current.grants} grant(s): remove them first`);
      }
      db.prepare("DELETE FROM access_profiles WHERE id = ?").run(current.id);
      access.log(realUser, "profile.delete", { id: current.id, name: current.name });
      return reply.code(204).send();
    },
  );

  // ---- выдачи ----

  app.get(
    "/api/v1/access/grants",
    {
      schema: {
        tags: ["access"],
        summary: "Grants «who × where × profile»: all (superadmin) or of one space (its admins)",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { spaceId: { type: "string", maxLength: 64 } },
        },
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: looseObject } } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const { spaceId } = request.query as { spaceId?: string };
      const { user } = requireGrantRight(request, spaceId ?? null);
      return {
        items: spaceId
          ? grants(
              user,
              "(g.space_id = ? OR g.branch_id IN (SELECT id FROM tickets WHERE space_id = ?))",
              spaceId,
              spaceId,
            )
          : grants(user),
      };
    },
  );

  app.post(
    "/api/v1/access/grants",
    {
      schema: {
        tags: ["access"],
        summary:
          "Grant a profile: who × where. Lead and PM come from the group card, so a new lead gets the rights at once",
        body: grantBody,
        response: { 201: looseObject, ...problemResponses },
      },
    },
    async (request, reply) => {
      const input = request.body as AccessGrantInput;
      const branch = input.place.branchKey
        ? (db.prepare("SELECT id, space_id FROM tickets WHERE key = ?").get(input.place.branchKey.toUpperCase()) as
            | { id: string; space_id: string }
            | undefined)
        : null;
      if (input.place.branchKey && !branch) {
        throw new AppError(400, "validation_failed", "Unknown branch", [
          { field: "place.branchKey", message: "no ticket with this key" },
        ]);
      }
      const spaceId = input.place.spaceId ?? branch?.space_id ?? null;
      const { user, realUser } = requireGrantRight(request, spaceId);
      if (branch && input.place.spaceId && branch.space_id !== input.place.spaceId) {
        throw new AppError(400, "validation_failed", "The branch is in another space", [
          { field: "place.branchKey", message: "choose a ticket of this space" },
        ]);
      }
      if (input.place.spaceId && !db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(input.place.spaceId)) {
        throw new AppError(400, "validation_failed", "Unknown space", [
          { field: "place.spaceId", message: "not found" },
        ]);
      }
      const subjectTable: Partial<Record<SubjectKind, string>> = {
        person: "users",
        team: "feature_teams",
        team_pm: "feature_teams",
        guild: "guilds",
        guild_lead: "guilds",
      };
      const table = subjectTable[input.subject.kind];
      if (input.subject.kind === "everyone" && input.subject.id) {
        throw new AppError(400, "validation_failed", "«Everyone» has no id", [
          { field: "subject.id", message: "must be null" },
        ]);
      }
      if (["person", "team", "guild"].includes(input.subject.kind) && !input.subject.id) {
        throw new AppError(400, "validation_failed", "Choose whom to grant", [
          { field: "subject.id", message: "required" },
        ]);
      }
      if (table && input.subject.id && !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(input.subject.id)) {
        throw new AppError(400, "validation_failed", "Unknown person or group", [
          { field: "subject.id", message: "not found" },
        ]);
      }
      if ((input.place.fieldKey === null) !== (input.place.fieldValue === null)) {
        throw new AppError(400, "validation_failed", "A dimension place needs both the field and the value", [
          { field: "place.fieldValue", message: "fill in both or none" },
        ]);
      }
      if (input.place.fieldKey && !db.prepare("SELECT 1 FROM ticket_fields WHERE key = ?").get(input.place.fieldKey)) {
        throw new AppError(400, "validation_failed", "Unknown field", [
          { field: "place.fieldKey", message: "not found" },
        ]);
      }
      profile(user, input.profileId);
      const id = randomUUID();
      db.prepare(
        `INSERT INTO access_grants (id, subject_kind, subject_id, space_id, branch_id, field_key, field_value, profile_id, is_test, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.subject.kind,
        input.subject.id,
        input.place.spaceId,
        branch?.id ?? null,
        input.place.fieldKey,
        input.place.fieldValue,
        input.profileId,
        user.isTest ? 1 : 0,
        realUser.id,
        Date.now(),
      );
      access.log(realUser, "grant.create", { id, ...input });
      return reply.code(201).send(grants(user, "g.id = ?", id)[0]);
    },
  );

  app.delete(
    "/api/v1/access/grants/:id",
    {
      schema: {
        tags: ["access"],
        summary: "Take a grant back",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = db
        .prepare(
          "SELECT g.id, coalesce(g.space_id, t.space_id) AS space_id FROM access_grants g LEFT JOIN tickets t ON t.id = g.branch_id WHERE g.id = ?",
        )
        .get(id) as { id: string; space_id: string | null } | undefined;
      if (!row) throw new AppError(404, "not_found", "Grant not found");
      const { realUser } = requireGrantRight(request, row.space_id);
      db.prepare("DELETE FROM access_grants WHERE id = ?").run(id);
      access.log(realUser, "grant.delete", { id });
      return reply.code(204).send();
    },
  );

  // ---- маска полей ----

  app.get(
    "/api/v1/access/masks",
    {
      schema: {
        tags: ["access"],
        summary: "Field masks: which profiles do not see which fields",
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["fieldId", "profileIds"],
                  properties: { fieldId: { type: "string" }, profileIds: { type: "array", items: { type: "string" } } },
                },
              },
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      requireAuth(request);
      const map = new Map<string, string[]>();
      for (const row of db.prepare("SELECT field_id, profile_id FROM field_masks").all() as {
        field_id: string;
        profile_id: string;
      }[]) {
        map.set(row.field_id, [...(map.get(row.field_id) ?? []), row.profile_id]);
      }
      return { items: [...map].map(([fieldId, profileIds]) => ({ fieldId, profileIds })) };
    },
  );

  app.put(
    "/api/v1/access/masks/:id",
    {
      schema: {
        tags: ["access"],
        summary: "Hide a field from profiles (superadmin). A viewer sees the field if any of their profiles does",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["profileIds"],
          properties: { profileIds: { type: "array", maxItems: 200, items: { type: "string", maxLength: 64 } } },
        },
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user, realUser } = requireSuperadmin(request);
      const { id } = request.params as { id: string };
      const { profileIds } = request.body as { profileIds: string[] };
      if (!db.prepare("SELECT 1 FROM ticket_fields WHERE id = ?").get(id))
        throw new AppError(404, "not_found", "Field not found");
      for (const profileId of profileIds) profile(user, profileId);
      db.transaction(() => {
        db.prepare("DELETE FROM field_masks WHERE field_id = ?").run(id);
        const insert = db.prepare("INSERT OR IGNORE INTO field_masks (field_id, profile_id) VALUES (?, ?)");
        for (const profileId of profileIds) insert.run(id, profileId);
      })();
      access.log(realUser, "mask.update", { fieldId: id, profileIds });
      return reply.code(204).send();
    },
  );

  // ---- журнал безопасности ----

  app.get(
    "/api/v1/access/log",
    {
      schema: {
        tags: ["access"],
        summary: "Security log: grants, visibility, exports, «View as» (superadmin)",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: looseObject } } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      requireSuperadmin(request);
      const items = (
        db
          .prepare("SELECT id, at, actor_name, action, detail FROM security_events ORDER BY at DESC LIMIT 300")
          .all() as {
          id: string;
          at: number;
          actor_name: string;
          action: string;
          detail: string;
        }[]
      ).map(
        (row): SecurityEvent => ({
          id: row.id,
          at: new Date(row.at).toISOString(),
          actorName: row.actor_name,
          action: row.action,
          detail: json<Record<string, unknown>>(row.detail, {}),
        }),
      );
      return { items };
    },
  );

  // ---- «Смотреть как» и «Режим показа» ----

  app.put(
    "/api/v1/me/lens",
    {
      schema: {
        tags: ["me"],
        summary:
          "Look at YourTask through a role (anyone) or a person (superadmin). show = «Show mode» from the header: the role is remembered. " +
          "While it is on, the API returns only what the role sees",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "id"],
          properties: {
            kind: { type: "string", enum: ["profile", "person"] },
            id: { type: "string", maxLength: 64 },
            show: { type: "boolean" },
          },
        },
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = request.body as { kind: "profile" | "person"; id: string; show?: boolean };
      if (body.kind === "person") {
        if (auth.realUser.role !== "superadmin")
          throw new AppError(403, "forbidden", "Only a superadmin looks through a person's eyes");
        if (!auth.session.mfa) throw new AppError(403, "mfa_required", "Sign in again with a second factor");
        const target = db
          .prepare(
            `SELECT id FROM users WHERE id = ? AND deactivated_at IS NULL AND ${testScope(auth.realUser, "is_test")}`,
          )
          .get(body.id);
        if (!target) throw new AppError(404, "not_found", "Person not found");
      } else {
        profile(auth.realUser, body.id);
        if (body.show) db.prepare("UPDATE users SET show_profile_id = ? WHERE id = ?").run(body.id, auth.realUser.id);
      }
      sessions.setLens(auth.session.id, {
        kind: body.kind,
        id: body.id,
        show: body.kind === "profile" && Boolean(body.show),
      });
      access.log(auth.realUser, "lens.on", { kind: body.kind, id: body.id, show: Boolean(body.show) });
      return reply.code(204).send();
    },
  );

  app.delete(
    "/api/v1/me/lens",
    {
      schema: {
        tags: ["me"],
        summary: "Leave «View as» / «Show mode»: full access returns",
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      if (auth.session.lensKind) {
        sessions.setLens(auth.session.id, null);
        access.log(auth.realUser, "lens.off", {});
      }
      return reply.code(204).send();
    },
  );
};
