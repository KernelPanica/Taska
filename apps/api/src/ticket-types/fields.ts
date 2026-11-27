import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { FIELD_KINDS, type FieldKind, type TicketField, type TicketFieldInput } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type UserRow } from "../auth/sessions.js";
import { createdAsTest, idParams, isUniqueViolation, nameSchema, visibleSql } from "../directory/common.js";
import { normalizeLabels, placeholders, systemKey, writeLabels } from "./common.js";

/**
 * Поля тикетов (R-2.5, R-2.7, docs/adr/0010): текст, число, дата, список, человек, шкала оценки, измерение.
 * Системное имя — латиницей, для TQL; после создания не меняется, как и вид, шкала и измерение.
 */
interface FieldRow {
  id: string;
  key: string;
  name: string;
  kind: FieldKind;
  multiple: number;
  scale_id: string | null;
  dimension_id: string | null;
  is_system: number;
}

const MAX_OPTIONS = 200;

export const fieldSchema = {
  type: "object",
  required: ["id", "key", "name", "kind", "options", "multiple", "scaleId", "dimensionId", "system"],
  properties: {
    id: { type: "string" },
    key: { type: "string", description: "System name for TQL" },
    name: { type: "string" },
    kind: { type: "string", enum: FIELD_KINDS },
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label"],
        properties: { id: { type: "string" }, label: { type: "string" } },
      },
    },
    multiple: { type: "boolean" },
    scaleId: { type: ["string", "null"] },
    dimensionId: { type: ["string", "null"] },
    system: { type: "boolean" },
  },
} as const;

const optionsSchema = {
  type: "array",
  maxItems: MAX_OPTIONS,
  items: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" },
} as const;

const invalid = (field: string, message: string, detail = message) => {
  throw new AppError(400, "validation_failed", detail, [{ field, message }]);
};

export function fieldService(db: Database) {
  function hydrate(rows: FieldRow[]): TicketField[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const options = db
      .prepare(
        `SELECT id, field_id AS fieldId, label FROM ticket_field_options WHERE field_id IN (${placeholders(ids)}) ORDER BY position`,
      )
      .all(...ids) as { id: string; fieldId: string; label: string }[];
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      kind: row.kind,
      options: options.filter((option) => option.fieldId === row.id).map(({ id, label }) => ({ id, label })),
      multiple: row.multiple === 1,
      scaleId: row.scale_id,
      dimensionId: row.dimension_id,
      system: row.is_system === 1,
    }));
  }

  const select = "SELECT id, key, name, kind, multiple, scale_id, dimension_id, is_system FROM ticket_fields";

  const service = {
    list(viewer: UserRow) {
      return hydrate(
        db
          .prepare(`${select} WHERE ${visibleSql(viewer)} ORDER BY is_system DESC, name COLLATE NOCASE`)
          .all() as FieldRow[],
      );
    },
    get(viewer: UserRow, id: string) {
      const row = db.prepare(`${select} WHERE id = ? AND ${visibleSql(viewer)}`).get(id) as FieldRow | undefined;
      if (!row) throw new AppError(404, "not_found", "Field not found");
      return hydrate([row])[0] as TicketField;
    },
    create(viewer: UserRow, input: TicketFieldInput) {
      const options = normalizeLabels(input.options ?? []);
      if (input.kind === "list" && options.length === 0) invalid("options", "a list needs at least one value");
      if (input.kind !== "list" && options.length) invalid("options", "only a list has values");
      if (input.multiple && !["list", "person"].includes(input.kind))
        invalid("multiple", "only a list or a person can be multiple");
      if (input.kind === "estimate") {
        if (!input.scaleId) invalid("scaleId", "an estimate field needs a scale");
        const scale = db
          .prepare(`SELECT id FROM estimate_scales WHERE id = ? AND ${visibleSql(viewer)}`)
          .get(input.scaleId);
        if (!scale) invalid("scaleId", "unknown scale");
      } else if (input.scaleId) invalid("scaleId", "only an estimate field has a scale");
      if (input.kind === "dimension") {
        if (!input.dimensionId) invalid("dimensionId", "a dimension field needs a dimension");
        const dimension = db
          .prepare(`SELECT id FROM dimensions WHERE id = ? AND ${visibleSql(viewer)}`)
          .get(input.dimensionId);
        if (!dimension) invalid("dimensionId", "unknown dimension");
      } else if (input.dimensionId) invalid("dimensionId", "only a dimension field has a dimension");

      const id = randomUUID();
      const now = Date.now();
      const key = systemKey(input.name, input.key, "field");
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO ticket_fields (id, key, name, kind, multiple, scale_id, dimension_id, is_system, is_test, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          ).run(
            id,
            key,
            input.name.trim(),
            input.kind,
            input.multiple ? 1 : 0,
            input.kind === "estimate" ? input.scaleId : null,
            input.kind === "dimension" ? input.dimensionId : null,
            createdAsTest(viewer),
            now,
            now,
          );
          if (input.kind === "list") writeLabels(db, "ticket_field_options", "field_id", id, options);
        })();
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError(409, "conflict", `Field system name "${key}" is already used`);
        throw error;
      }
      return service.get(viewer, id);
    },
    update(viewer: UserRow, id: string, patch: { name?: string; options?: string[]; multiple?: boolean }) {
      const current = service.get(viewer, id);
      if (patch.options && current.kind !== "list") invalid("options", "only a list has values");
      if (patch.multiple !== undefined && !["list", "person"].includes(current.kind)) {
        invalid("multiple", "only a list or a person can be multiple");
      }
      const options = patch.options ? normalizeLabels(patch.options) : undefined;
      if (options && options.length === 0) invalid("options", "a list needs at least one value");
      db.transaction(() => {
        if (patch.name !== undefined)
          db.prepare("UPDATE ticket_fields SET name = ? WHERE id = ?").run(patch.name.trim(), id);
        if (patch.multiple !== undefined)
          db.prepare("UPDATE ticket_fields SET multiple = ? WHERE id = ?").run(Number(patch.multiple), id);
        if (options) writeLabels(db, "ticket_field_options", "field_id", id, options);
        db.prepare("UPDATE ticket_fields SET updated_at = ? WHERE id = ?").run(Date.now(), id);
      })();
      return service.get(viewer, id);
    },
    remove(viewer: UserRow, id: string) {
      const field = service.get(viewer, id);
      if (field.system) throw new AppError(409, "conflict", "System fields cannot be deleted");
      const types = db
        .prepare("SELECT t.name FROM ticket_type_fields f JOIN ticket_types t ON t.id = f.type_id WHERE f.field_id = ?")
        .all(id) as { name: string }[];
      if (types.length) {
        throw new AppError(
          409,
          "conflict",
          `Remove the field from types first: ${types.map((type) => type.name).join(", ")}`,
        );
      }
      db.prepare("DELETE FROM ticket_fields WHERE id = ?").run(id);
    },
  };
  return service;
}

export const fieldRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  const fields = fieldService(db);
  const tags = ["fields"];

  app.get(
    "/api/v1/fields",
    {
      schema: {
        tags,
        summary: "Ticket fields",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: fieldSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: fields.list(requireAuth(request).user) }),
  );

  app.get(
    "/api/v1/fields/:id",
    { schema: { tags, summary: "One field", params: idParams, response: { 200: fieldSchema, ...problemResponses } } },
    async (request) => fields.get(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.post(
    "/api/v1/fields",
    {
      schema: {
        tags,
        summary: "Create a field (superadmin)",
        description: "`key` is the Latin system name for TQL; made from the name when omitted.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind"],
          properties: {
            name: nameSchema,
            key: { type: "string", maxLength: 40 },
            kind: { type: "string", enum: FIELD_KINDS },
            options: optionsSchema,
            multiple: { type: "boolean" },
            scaleId: { type: ["string", "null"], maxLength: 64 },
            dimensionId: { type: ["string", "null"], maxLength: 64 },
          },
        },
        response: { 201: fieldSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      const field = fields.create(user, request.body as TicketFieldInput);
      request.log.info({ adminId: user.id, fieldId: field.id, kind: field.kind }, "Field created");
      return reply.code(201).send(field);
    },
  );

  app.patch(
    "/api/v1/fields/:id",
    {
      schema: {
        tags,
        summary:
          "Rename a field, change list values or multiple choice (superadmin). Kind, system name, scale and dimension are fixed.",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, options: optionsSchema, multiple: { type: "boolean" } },
        },
        response: { 200: fieldSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return fields.update(user, (request.params as { id: string }).id, request.body as { name?: string });
    },
  );

  app.delete(
    "/api/v1/fields/:id",
    {
      schema: {
        tags,
        summary: "Delete a custom field that no type uses (superadmin)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      fields.remove(user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );
};
