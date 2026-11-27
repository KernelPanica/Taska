import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { RIGHTS, type Right, type Space, type SpaceRole } from "@yourtask/contracts";
import { accessService } from "../access/service.js";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireSuperadmin, requireAuth, type UserRow } from "../auth/sessions.js";
import { createdAsTest, idParams, isUniqueViolation, nameSchema, slugify, visibleSql } from "../directory/common.js";

const spaceSchema = {
  type: "object",
  required: ["id", "slug", "name", "role", "rights", "enforceSubordination", "createdAt"],
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    role: { anyOf: [{ type: "string", enum: ["owner", "member"] }, { type: "null" }] },
    rights: { type: "array", items: { type: "string", enum: RIGHTS } },
    enforceSubordination: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

interface SpaceRow {
  id: string;
  slug: string;
  name: string;
  enforce_subordination: number;
  created_at: number;
}

/**
 * Пространства (R-2.16) — граница прав: пространство видно, если зрителю выдано хоть что-то с правом «Смотреть»
 * в нём или шире (R-2.20, docs/adr/0014); суперадмин видит все. Тестовые пространства не видны обычным
 * пользователям (docs/adr/0006). Стартовые пространства создаёт миграция.
 */
/** Пространство, которое видит зритель, иначе 404. */
export function requireVisibleSpace(db: Database, viewer: UserRow, id: string) {
  const row = db
    .prepare(`SELECT s.id, s.enforce_subordination FROM spaces s WHERE s.id = ? AND ${visibleSql(viewer, "s.is_test")}`)
    .get(id) as { id: string; enforce_subordination: number } | undefined;
  const visible = row ? accessService(db).visibleSpaceIds(viewer) : null;
  if (!row || !visible || (visible !== "all" && !visible.has(row.id))) {
    throw new AppError(404, "not_found", "Space not found");
  }
  return { id: row.id, enforceSubordination: row.enforce_subordination === 1 };
}

export const spaceRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  const access = accessService(db);

  function find(viewer: UserRow, where: string, ...params: unknown[]): Space[] {
    const ctx = access.context(viewer);
    const visible = access.visibleSpaceIds(viewer, ctx);
    return (
      db
        .prepare(
          `SELECT s.id, s.slug, s.name, s.enforce_subordination, s.created_at FROM spaces s
           WHERE ${visibleSql(viewer, "s.is_test")} AND ${where}
           ORDER BY s.name COLLATE NOCASE`,
        )
        .all(...params) as SpaceRow[]
    )
      .filter((row) => visible === "all" || visible.has(row.id))
      .map((row) => {
        const rights: Right[] = [...access.spaceRights(viewer, row.id, ctx)];
        const granted = ctx.grants.some((grant) => grant.spaceId === row.id);
        const role: SpaceRole | null = ctx.superadmin
          ? null
          : rights.includes("grant")
            ? "owner"
            : granted || rights.includes("view")
              ? "member"
              : null;
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          role,
          rights,
          enforceSubordination: row.enforce_subordination === 1,
          createdAt: new Date(row.created_at).toISOString(),
        };
      });
  }

  function one(viewer: UserRow, where: string, ...params: unknown[]) {
    const space = find(viewer, where, ...params)[0];
    if (!space) throw new AppError(404, "not_found", "Space not found");
    return space;
  }

  app.get(
    "/api/v1/spaces",
    {
      schema: {
        tags: ["spaces"],
        summary: "Spaces where the viewer sees at least some tickets (all for a superadmin), with the viewer's rights",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: spaceSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: find(requireAuth(request).user, "1 = 1") }),
  );

  app.get(
    "/api/v1/spaces/:slug",
    {
      schema: {
        tags: ["spaces"],
        summary: "One space by slug",
        params: { type: "object", required: ["slug"], properties: { slug: { type: "string", maxLength: 100 } } },
        response: { 200: spaceSchema, ...problemResponses },
      },
    },
    async (request) => one(requireAuth(request).user, "s.slug = ?", (request.params as { slug: string }).slug),
  );

  app.post(
    "/api/v1/spaces",
    {
      schema: {
        tags: ["spaces"],
        summary: "Create a space (superadmin)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: nameSchema, slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,59}$" } },
        },
        response: { 201: spaceSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      const { name, slug } = request.body as { name: string; slug?: string };
      const id = randomUUID();
      const now = Date.now();
      const finalSlug = slug ?? slugify(name, "space");
      try {
        db.prepare(
          "INSERT INTO spaces (id, slug, name, is_test, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, finalSlug, name.trim(), createdAsTest(user), now, now);
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, "conflict", `Space address "${finalSlug}" is already used`);
        throw error;
      }
      request.log.info({ adminId: user.id, spaceId: id }, "Space created");
      return reply.code(201).send(one(user, "s.id = ?", id));
    },
  );

  app.patch(
    "/api/v1/spaces/:id",
    {
      schema: {
        tags: ["spaces"],
        summary: "Rename a space or switch type subordination rules (superadmin). The address (slug) stays the same.",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, enforceSubordination: { type: "boolean" } },
        },
        response: { 200: spaceSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      const { id } = request.params as { id: string };
      one(user, "s.id = ?", id);
      const body = request.body as { name?: string; enforceSubordination?: boolean };
      db.prepare(
        "UPDATE spaces SET name = coalesce(?, name), enforce_subordination = coalesce(?, enforce_subordination), updated_at = ? WHERE id = ?",
      ).run(
        body.name?.trim() ?? null,
        body.enforceSubordination === undefined ? null : Number(body.enforceSubordination),
        Date.now(),
        id,
      );
      if (body.enforceSubordination !== undefined) {
        request.log.info(
          { adminId: user.id, spaceId: id, on: body.enforceSubordination },
          "Subordination rules switched",
        );
      }
      return one(user, "s.id = ?", id);
    },
  );
};
