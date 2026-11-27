import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  DAYS_SCALE_KEY,
  rollupEstimates,
  SCALE_KINDS,
  type Converter,
  type ConverterEntry,
  type Estimate,
  type EstimateScale,
  type EstimateScaleInput,
  type ScaleKind,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type UserRow } from "../auth/sessions.js";
import { createdAsTest, idParams, isUniqueViolation, nameSchema, visibleSql } from "../directory/common.js";
import { requireVisibleSpace } from "../spaces/routes.js";
import { normalizeLabels, placeholders, systemKey, writeLabels } from "./common.js";

/**
 * Шкалы оценки и конвертер (R-2.26, docs/adr/0010). Стартовые «Майки» (XS–XL) и «Дни» создаёт миграция.
 * Конвертер по умолчанию действует во всех пространствах; пространство может завести свой.
 */
interface ScaleRow {
  id: string;
  key: string;
  name: string;
  kind: ScaleKind;
  unit: string | null;
  is_system: number;
}

const MAX_VALUES = 50;
const MAX_DAYS = 10_000;

export const scaleSchema = {
  type: "object",
  required: ["id", "key", "name", "kind", "unit", "values", "system"],
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    kind: { type: "string", enum: SCALE_KINDS },
    unit: { type: ["string", "null"] },
    values: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label"],
        properties: { id: { type: "string" }, label: { type: "string" } },
      },
    },
    system: { type: "boolean" },
  },
} as const;

const entrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["scaleId", "valueId", "minDays", "maxDays"],
  properties: {
    scaleId: { type: "string", maxLength: 64 },
    valueId: { type: ["string", "null"], maxLength: 64 },
    minDays: { type: "number", minimum: 0, maximum: MAX_DAYS },
    maxDays: { type: "number", minimum: 0, maximum: MAX_DAYS },
  },
} as const;

const converterSchema = {
  type: "object",
  required: ["spaceId", "inherited", "entries"],
  properties: {
    spaceId: { type: ["string", "null"] },
    inherited: { type: "boolean" },
    entries: { type: "array", items: entrySchema },
  },
} as const;

const valuesSchema = {
  type: "array",
  maxItems: MAX_VALUES,
  items: { type: "string", minLength: 1, maxLength: 40, pattern: "\\S" },
} as const;

const estimateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scaleId", "value"],
  properties: { scaleId: { type: "string", maxLength: 64 }, value: { type: ["string", "number"] } },
} as const;

export function scaleService(db: Database) {
  function hydrate(rows: ScaleRow[]): EstimateScale[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const values = db
      .prepare(
        `SELECT id, scale_id AS scaleId, label FROM estimate_scale_values WHERE scale_id IN (${placeholders(ids)}) ORDER BY position`,
      )
      .all(...ids) as { id: string; scaleId: string; label: string }[];
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      kind: row.kind,
      unit: row.unit,
      values: values.filter((value) => value.scaleId === row.id).map(({ id, label }) => ({ id, label })),
      system: row.is_system === 1,
    }));
  }

  const select = "SELECT id, key, name, kind, unit, is_system FROM estimate_scales";

  function readEntries(spaceId: string | null): ConverterEntry[] {
    return db
      .prepare(
        `SELECT scale_id AS scaleId, value_id AS valueId, min_days AS minDays, max_days AS maxDays
         FROM estimate_converter_entries WHERE ${spaceId === null ? "space_id IS NULL" : "space_id = ?"}`,
      )
      .all(...(spaceId === null ? [] : [spaceId])) as ConverterEntry[];
  }

  const service = {
    list(viewer: UserRow) {
      return hydrate(
        db
          .prepare(`${select} WHERE ${visibleSql(viewer)} ORDER BY is_system DESC, name COLLATE NOCASE`)
          .all() as ScaleRow[],
      );
    },
    get(viewer: UserRow, id: string) {
      const row = db.prepare(`${select} WHERE id = ? AND ${visibleSql(viewer)}`).get(id) as ScaleRow | undefined;
      if (!row) throw new AppError(404, "not_found", "Estimate scale not found");
      return hydrate([row])[0] as EstimateScale;
    },
    create(viewer: UserRow, input: EstimateScaleInput) {
      const values = normalizeLabels(input.values ?? []);
      if (input.kind === "ordinal" && values.length < 2) {
        throw new AppError(400, "validation_failed", "An ordinal scale needs at least two values", [
          { field: "values", message: "at least two values" },
        ]);
      }
      if (input.kind === "numeric" && values.length) {
        throw new AppError(400, "validation_failed", "A numeric scale has no values", [
          { field: "values", message: "must be empty for numeric" },
        ]);
      }
      const id = randomUUID();
      const now = Date.now();
      const key = systemKey(input.name, input.key, "scale");
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO estimate_scales (id, key, name, kind, unit, is_system, is_test, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          ).run(
            id,
            key,
            input.name.trim(),
            input.kind,
            input.kind === "numeric" ? input.unit?.trim() || null : null,
            createdAsTest(viewer),
            now,
            now,
          );
          if (input.kind === "ordinal") writeLabels(db, "estimate_scale_values", "scale_id", id, values);
        })();
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError(409, "conflict", `Scale key "${key}" is already used`);
        throw error;
      }
      return service.get(viewer, id);
    },
    update(viewer: UserRow, id: string, patch: { name?: string; unit?: string | null; values?: string[] }) {
      const current = service.get(viewer, id);
      if (patch.values && current.kind !== "ordinal") {
        throw new AppError(400, "validation_failed", "Only an ordinal scale has values", [
          { field: "values", message: "only for ordinal" },
        ]);
      }
      const values = patch.values ? normalizeLabels(patch.values) : undefined;
      if (values && values.length < 2) {
        throw new AppError(400, "validation_failed", "An ordinal scale needs at least two values", [
          { field: "values", message: "at least two values" },
        ]);
      }
      db.transaction(() => {
        if (patch.name !== undefined)
          db.prepare("UPDATE estimate_scales SET name = ? WHERE id = ?").run(patch.name.trim(), id);
        if (patch.unit !== undefined && current.kind === "numeric") {
          db.prepare("UPDATE estimate_scales SET unit = ? WHERE id = ?").run(patch.unit?.trim() || null, id);
        }
        if (values) writeLabels(db, "estimate_scale_values", "scale_id", id, values);
        db.prepare("UPDATE estimate_scales SET updated_at = ? WHERE id = ?").run(Date.now(), id);
      })();
      return service.get(viewer, id);
    },
    remove(viewer: UserRow, id: string) {
      const scale = service.get(viewer, id);
      if (scale.system) throw new AppError(409, "conflict", "System scales cannot be deleted");
      const used = db.prepare("SELECT name FROM ticket_fields WHERE scale_id = ?").all(id) as { name: string }[];
      if (used.length) {
        throw new AppError(
          409,
          "conflict",
          `The scale is used by fields: ${used.map((field) => field.name).join(", ")}`,
        );
      }
      db.prepare("DELETE FROM estimate_scales WHERE id = ?").run(id);
    },

    /** Конвертер пространства (свой или по умолчанию) или конвертер по умолчанию (spaceId = null). */
    converter(spaceId: string | null): Converter {
      if (spaceId !== null) {
        const own = readEntries(spaceId);
        if (own.length) return { spaceId, inherited: false, entries: own };
        return { spaceId, inherited: true, entries: readEntries(null) };
      }
      return { spaceId: null, inherited: false, entries: readEntries(null) };
    },

    /** Заменяет строки конвертера целиком. Проверяет шкалы и значения. */
    writeConverter(viewer: UserRow, spaceId: string | null, entries: ConverterEntry[]) {
      const scales = new Map(service.list(viewer).map((scale) => [scale.id, scale]));
      const seen = new Set<string>();
      entries.forEach((item, index) => {
        const field = `entries/${index}`;
        const scale = scales.get(item.scaleId);
        const fail = (message: string) => {
          throw new AppError(400, "validation_failed", "Invalid converter row", [{ field, message }]);
        };
        if (!scale) fail("unknown scale");
        if (scale?.key === DAYS_SCALE_KEY) fail("the days scale needs no conversion");
        if (scale?.kind === "ordinal" && !scale.values.some((value) => value.id === item.valueId))
          fail("unknown value of the scale");
        if (scale?.kind === "numeric" && item.valueId !== null)
          fail("a numeric scale has one row per unit: valueId must be null");
        if (scale?.kind === "numeric" && item.minDays <= 0) fail("days per unit must be above zero");
        if (item.maxDays < item.minDays) fail("maxDays must not be less than minDays");
        const key = `${item.scaleId}|${item.valueId ?? ""}`;
        if (seen.has(key)) fail("duplicate row");
        seen.add(key);
      });
      db.transaction(() => {
        db.prepare(
          `DELETE FROM estimate_converter_entries WHERE ${spaceId === null ? "space_id IS NULL" : "space_id = ?"}`,
        ).run(...(spaceId === null ? [] : [spaceId]));
        const insert = db.prepare(
          "INSERT INTO estimate_converter_entries (id, space_id, scale_id, value_id, min_days, max_days) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const item of entries)
          insert.run(randomUUID(), spaceId, item.scaleId, item.valueId, item.minDays, item.maxDays);
      })();
      return service.converter(spaceId);
    },

    resetConverter(spaceId: string) {
      db.prepare("DELETE FROM estimate_converter_entries WHERE space_id = ?").run(spaceId);
      return service.converter(spaceId);
    },
  };
  return service;
}

export const scaleRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  const scales = scaleService(db);
  const tags = ["estimates"];

  app.get(
    "/api/v1/estimate-scales",
    {
      schema: {
        tags,
        summary: "Estimate scales: T-shirt XS–XL, days and custom ones",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: scaleSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: scales.list(requireAuth(request).user) }),
  );

  app.get(
    "/api/v1/estimate-scales/:id",
    {
      schema: {
        tags,
        summary: "One estimate scale",
        params: idParams,
        response: { 200: scaleSchema, ...problemResponses },
      },
    },
    async (request) => scales.get(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.post(
    "/api/v1/estimate-scales",
    {
      schema: {
        tags,
        summary: "Create an estimate scale (superadmin)",
        description:
          "ordinal — ordered values (like T-shirt sizes); numeric — a number with a unit (like story points).",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind"],
          properties: {
            name: nameSchema,
            key: { type: "string", maxLength: 40 },
            kind: { type: "string", enum: SCALE_KINDS },
            unit: { type: ["string", "null"], maxLength: 20 },
            values: valuesSchema,
          },
        },
        response: { 201: scaleSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      const scale = scales.create(user, request.body as EstimateScaleInput);
      request.log.info({ adminId: user.id, scaleId: scale.id }, "Estimate scale created");
      return reply.code(201).send(scale);
    },
  );

  app.patch(
    "/api/v1/estimate-scales/:id",
    {
      schema: {
        tags,
        summary: "Rename a scale, change its unit or values (superadmin). Kind is fixed.",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, unit: { type: ["string", "null"], maxLength: 20 }, values: valuesSchema },
        },
        response: { 200: scaleSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return scales.update(user, (request.params as { id: string }).id, request.body as { name?: string });
    },
  );

  app.delete(
    "/api/v1/estimate-scales/:id",
    {
      schema: {
        tags,
        summary: "Delete a custom scale not used by fields (superadmin)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      scales.remove(user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );

  const converterBody = {
    type: "object",
    additionalProperties: false,
    required: ["entries"],
    properties: { entries: { type: "array", maxItems: 2000, items: entrySchema } },
  } as const;

  app.get(
    "/api/v1/estimate-converter",
    {
      schema: {
        tags,
        summary: "Default converter for every space",
        response: { 200: converterSchema, ...problemResponses },
      },
    },
    async (request) => {
      requireAuth(request);
      return scales.converter(null);
    },
  );

  app.put(
    "/api/v1/estimate-converter",
    {
      schema: {
        tags,
        summary: "Replace the default converter (superadmin)",
        body: converterBody,
        response: { 200: converterSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return scales.writeConverter(user, null, (request.body as { entries: ConverterEntry[] }).entries);
    },
  );

  app.get(
    "/api/v1/spaces/:id/estimate-converter",
    {
      schema: {
        tags,
        summary: "Converter of a space: its own or the default one (inherited)",
        params: idParams,
        response: { 200: converterSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      return scales.converter(requireVisibleSpace(db, user, (request.params as { id: string }).id).id);
    },
  );

  app.put(
    "/api/v1/spaces/:id/estimate-converter",
    {
      schema: {
        tags,
        summary: "Set the space's own converter (superadmin)",
        params: idParams,
        body: converterBody,
        response: { 200: converterSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      const space = requireVisibleSpace(db, user, (request.params as { id: string }).id);
      return scales.writeConverter(user, space.id, (request.body as { entries: ConverterEntry[] }).entries);
    },
  );

  app.delete(
    "/api/v1/spaces/:id/estimate-converter",
    {
      schema: {
        tags,
        summary: "Drop the space's own converter: the default one applies again (superadmin)",
        params: idParams,
        response: { 200: converterSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return scales.resetConverter(requireVisibleSpace(db, user, (request.params as { id: string }).id).id);
    },
  );

  app.post(
    "/api/v1/estimates/rollup",
    {
      schema: {
        tags,
        summary: "Sum children's estimates in the scale the viewer chose (R-2.12, R-2.26)",
        description:
          "Each child counts once. A child's estimate in the chosen scale is used as is; otherwise its first estimate " +
          "is converted with the space converter. Numeric scales sum in their units, ordinal ones in days and map back " +
          "to the nearest value. Tickets arrive in YT-06; rollups on parents run in YT-10 with the same rules.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["targetScaleId", "children"],
          properties: {
            spaceId: { type: ["string", "null"], maxLength: 64 },
            targetScaleId: { type: "string", maxLength: 64 },
            children: {
              type: "array",
              maxItems: 10_000,
              items: { type: "array", maxItems: 20, items: estimateSchema },
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["result", "counted", "skipped"],
            properties: {
              result: {
                anyOf: [
                  {
                    type: "object",
                    required: ["scaleId", "min", "max", "valueId", "exact"],
                    properties: {
                      scaleId: { type: "string" },
                      min: { type: "number" },
                      max: { type: "number" },
                      valueId: { type: ["string", "null"] },
                      exact: { type: "boolean" },
                    },
                  },
                  { type: "null" },
                ],
              },
              counted: { type: "integer" },
              skipped: { type: "integer" },
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const body = request.body as { spaceId?: string | null; targetScaleId: string; children: Estimate[][] };
      const spaceId = body.spaceId ? requireVisibleSpace(db, user, body.spaceId).id : null;
      const all = scales.list(user);
      const target = all.find((scale) => scale.id === body.targetScaleId);
      if (!target) {
        throw new AppError(400, "validation_failed", "Unknown scale", [
          { field: "targetScaleId", message: "unknown scale" },
        ]);
      }
      return rollupEstimates(body.children, target, all, scales.converter(spaceId));
    },
  );
};
