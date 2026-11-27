import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  DIMENSION_KINDS,
  DIMENSION_SOURCES,
  type Dimension,
  type DimensionInput,
  type DimensionKind,
  type DimensionSource,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireSuperadmin, requireAuth, type UserRow } from "../auth/sessions.js";
import { createdAsTest, idParams, isUniqueViolation, nameSchema, slugify, visibleSql } from "./common.js";

/**
 * Конструктор измерений (R-2.15, docs/adr/0008): «группа людей» — значения берутся из фичекоманд
 * или колодцев; «список» — значения задаёт админ. Одиночный или множественный выбор.
 * Стартовые системные измерения team и stream создаёт миграция.
 */
interface DimensionRow {
  id: string;
  key: string;
  name: string;
  kind: DimensionKind;
  source: DimensionSource | null;
  multiple: number;
  is_system: number;
}

const MAX_OPTIONS = 200;

const dimensionSchema = {
  type: "object",
  required: ["id", "key", "name", "kind", "source", "multiple", "system", "options"],
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    kind: { type: "string", enum: DIMENSION_KINDS },
    source: { anyOf: [{ type: "string", enum: DIMENSION_SOURCES }, { type: "null" }] },
    multiple: { type: "boolean" },
    system: { type: "boolean" },
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label"],
        properties: { id: { type: "string" }, label: { type: "string" } },
      },
    },
  },
} as const;

const optionsSchema = {
  type: "array",
  maxItems: MAX_OPTIONS,
  items: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" },
} as const;

function normalizeOptions(options: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of options) {
    const label = raw.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    result.push(label);
  }
  return result;
}

export function dimensionService(db: Database) {
  function hydrate(rows: DimensionRow[]): Dimension[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const options = db
      .prepare(
        `SELECT id, dimension_id AS dimensionId, label FROM dimension_options WHERE dimension_id IN (${ids.map(() => "?").join(",")}) ORDER BY position`,
      )
      .all(...ids) as { id: string; dimensionId: string; label: string }[];
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      kind: row.kind,
      source: row.source,
      multiple: row.multiple === 1,
      system: row.is_system === 1,
      options: options.filter((option) => option.dimensionId === row.id).map(({ id, label }) => ({ id, label })),
    }));
  }

  /** Заменяет набор значений списка, сохраняя id у значений с тем же текстом. */
  function writeOptions(dimensionId: string, labels: readonly string[]) {
    const existing = db.prepare("SELECT id, label FROM dimension_options WHERE dimension_id = ?").all(dimensionId) as {
      id: string;
      label: string;
    }[];
    const byLabel = new Map(existing.map((option) => [option.label.toLowerCase(), option.id]));
    db.prepare("DELETE FROM dimension_options WHERE dimension_id = ?").run(dimensionId);
    const insert = db.prepare("INSERT INTO dimension_options (id, dimension_id, label, position) VALUES (?, ?, ?, ?)");
    labels.forEach((label, position) => {
      insert.run(byLabel.get(label.toLowerCase()) ?? randomUUID(), dimensionId, label, position);
    });
  }

  const select = "SELECT id, key, name, kind, source, multiple, is_system FROM dimensions";

  const service = {
    list(viewer: UserRow) {
      return hydrate(
        db
          .prepare(`${select} WHERE ${visibleSql(viewer)} ORDER BY is_system DESC, name COLLATE NOCASE`)
          .all() as DimensionRow[],
      );
    },
    get(viewer: UserRow, id: string) {
      const row = db.prepare(`${select} WHERE id = ? AND ${visibleSql(viewer)}`).get(id) as DimensionRow | undefined;
      if (!row) throw new AppError(404, "not_found", "Dimension not found");
      return hydrate([row])[0] as Dimension;
    },
    create(viewer: UserRow, input: DimensionInput) {
      if (input.kind === "people_group" && !input.source) {
        throw new AppError(400, "validation_failed", "A people group needs a source", [
          { field: "source", message: "required for people_group" },
        ]);
      }
      if (input.kind === "list" && input.source) {
        throw new AppError(400, "validation_failed", "A list has no source", [
          { field: "source", message: "must be empty for list" },
        ]);
      }
      if (input.kind === "people_group" && input.options?.length) {
        throw new AppError(400, "validation_failed", "Values of a people group come from its source", [
          { field: "options", message: "must be empty for people_group" },
        ]);
      }
      const id = randomUUID();
      const now = Date.now();
      const key = input.key?.trim() || slugify(input.name, "dimension");
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO dimensions (id, key, name, kind, source, multiple, is_system, is_test, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          ).run(
            id,
            key,
            input.name.trim(),
            input.kind,
            input.source ?? null,
            input.multiple ? 1 : 0,
            createdAsTest(viewer),
            now,
            now,
          );
          if (input.kind === "list") writeOptions(id, normalizeOptions(input.options ?? []));
        })();
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError(409, "conflict", `Dimension key "${key}" is already used`);
        throw error;
      }
      return service.get(viewer, id);
    },
    update(viewer: UserRow, id: string, patch: { name?: string; multiple?: boolean; options?: string[] }) {
      const current = service.get(viewer, id);
      if (patch.options && current.kind !== "list") {
        throw new AppError(400, "validation_failed", "Only list dimensions have editable values", [
          { field: "options", message: "only for list" },
        ]);
      }
      db.transaction(() => {
        if (patch.name !== undefined)
          db.prepare("UPDATE dimensions SET name = ? WHERE id = ?").run(patch.name.trim(), id);
        if (patch.multiple !== undefined)
          db.prepare("UPDATE dimensions SET multiple = ? WHERE id = ?").run(patch.multiple ? 1 : 0, id);
        if (patch.options) writeOptions(id, normalizeOptions(patch.options));
        db.prepare("UPDATE dimensions SET updated_at = ? WHERE id = ?").run(Date.now(), id);
      })();
      return service.get(viewer, id);
    },
    remove(viewer: UserRow, id: string) {
      if (service.get(viewer, id).system) throw new AppError(409, "conflict", "System dimensions cannot be deleted");
      db.prepare("DELETE FROM dimensions WHERE id = ?").run(id);
    },
  };
  return service;
}

export const dimensionRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  const dimensions = dimensionService(db);

  app.get(
    "/api/v1/dimensions",
    {
      schema: {
        tags: ["dimensions"],
        summary: "Dimensions for filters and boards",
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: dimensionSchema } },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: dimensions.list(requireAuth(request).user) }),
  );

  app.get(
    "/api/v1/dimensions/:id",
    {
      schema: {
        tags: ["dimensions"],
        summary: "One dimension",
        params: idParams,
        response: { 200: dimensionSchema, ...problemResponses },
      },
    },
    async (request) => dimensions.get(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.post(
    "/api/v1/dimensions",
    {
      schema: {
        tags: ["dimensions"],
        summary: "Create a dimension (superadmin)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind", "multiple"],
          properties: {
            name: nameSchema,
            key: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,59}$" },
            kind: { type: "string", enum: DIMENSION_KINDS },
            source: { anyOf: [{ type: "string", enum: DIMENSION_SOURCES }, { type: "null" }] },
            multiple: { type: "boolean" },
            options: optionsSchema,
          },
        },
        response: { 201: dimensionSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      const dimension = dimensions.create(user, request.body as DimensionInput);
      request.log.info({ adminId: user.id, dimensionId: dimension.id, kind: dimension.kind }, "Dimension created");
      return reply.code(201).send(dimension);
    },
  );

  app.patch(
    "/api/v1/dimensions/:id",
    {
      schema: {
        tags: ["dimensions"],
        summary: "Rename, change selection mode or list values (superadmin). Kind and source are fixed.",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, multiple: { type: "boolean" }, options: optionsSchema },
        },
        response: { 200: dimensionSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return dimensions.update(user, (request.params as { id: string }).id, request.body as { name?: string });
    },
  );

  app.delete(
    "/api/v1/dimensions/:id",
    {
      schema: {
        tags: ["dimensions"],
        summary: "Delete a custom dimension (superadmin)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      dimensions.remove(user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );
};
