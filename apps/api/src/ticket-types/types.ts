import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  CANCELLED_OUTCOME,
  COLOR_PATTERN,
  DEFAULT_OUTCOMES,
  type Outcome,
  DEFAULT_ROLLUPS,
  PROGRESS_SOURCES,
  TYPE_ICONS,
  type FieldValue,
  type RollupSettings,
  type TicketField,
  type TicketTemplate,
  type TicketTemplateInput,
  type TicketType,
  type TicketTypeInput,
  type TypeIcon,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type UserRow } from "../auth/sessions.js";
import {
  createdAsTest,
  idListSchema,
  idParams,
  isUniqueViolation,
  nameSchema,
  visibleSql,
} from "../directory/common.js";
import { requireVisibleSpace } from "../spaces/routes.js";
import { historyService } from "../tickets/history.js";
import { rollupService } from "../tickets/rollups.js";
import { treeStore } from "../tickets/tree.js";
import { json, placeholders, systemKey } from "./common.js";
import { fieldService } from "./fields.js";
import { scaleService } from "./scales.js";

/**
 * Типы тикетов и шаблоны (R-2.5, R-2.7, R-2.12, docs/adr/0010).
 * Тип: имя, цвет, иконка, поля, шаблоны, настройки свёрток (только хранение — считает YT-10)
 * и ограничитель подчинения (какие типы могут быть родителем), который действует только
 * в пространствах, где включён. Шаблон подставляет структуру описания, чеклист и значения полей.
 */
interface TypeRow {
  id: string;
  key: string;
  name: string;
  color: string;
  icon: TypeIcon;
  rollups: string;
  outcomes: string;
  is_system: number;
}

interface TemplateRow {
  id: string;
  type_id: string;
  name: string;
  description: string;
  checklist: string;
  field_values: string;
  is_system: number;
}

const rollupsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "boolean", description: "First child in progress moves the parent; all closed raises a flag" },
    progress: { type: "string", enum: PROGRESS_SOURCES },
    progressByEstimate: { type: "boolean", description: "Weight children by estimate instead of equally" },
    dates: { type: "boolean" },
    estimates: { type: "boolean" },
  },
} as const;

const outcomeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "label"],
  properties: {
    key: { type: "string", pattern: "^[a-z][a-z0-9_]{1,39}$" },
    label: { type: "string", minLength: 1, maxLength: 60, pattern: "\\S" },
  },
} as const;

const typeSchema = {
  type: "object",
  required: [
    "id",
    "key",
    "name",
    "color",
    "icon",
    "fieldIds",
    "rollups",
    "outcomes",
    "allowedParentTypeIds",
    "templates",
    "system",
  ],
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    color: { type: "string" },
    icon: { type: "string", enum: TYPE_ICONS },
    fieldIds: { type: "array", items: { type: "string" }, description: "Fields in card order" },
    rollups: { ...rollupsSchema, required: ["status", "progress", "progressByEstimate", "dates", "estimates"] },
    allowedParentTypeIds: {
      type: "array",
      items: { type: "string" },
      description: "Subordination rule: allowed parent types; empty means any. Applies only where a space enables it.",
    },
    templates: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    outcomes: { type: "array", items: outcomeSchema },
    system: { type: "boolean" },
  },
} as const;

// Порядок важен: Ajv приводит типы (coerceTypes). null — первым (иначе станет 0), число — раньше строки, массив — после.
const fieldValueSchema = {
  anyOf: [
    { type: "null" },
    { type: "number" },
    { type: "string", maxLength: 5000 },
    { type: "array", maxItems: 200, items: { type: "string", maxLength: 64 } },
  ],
} as const;

const templateSchema = {
  type: "object",
  required: ["id", "typeId", "name", "description", "checklist", "values", "system"],
  properties: {
    id: { type: "string" },
    typeId: { type: "string" },
    name: { type: "string" },
    description: { type: "string", description: "Description structure, Markdown" },
    checklist: { type: "array", items: { type: "string" } },
    values: { type: "object", additionalProperties: fieldValueSchema, description: "Field values by system name" },
    system: { type: "boolean" },
  },
} as const;

const typeInputProperties = {
  name: nameSchema,
  color: { type: "string", pattern: COLOR_PATTERN },
  icon: { type: "string", enum: TYPE_ICONS },
  fieldIds: idListSchema,
  rollups: rollupsSchema,
  allowedParentTypeIds: idListSchema,
  outcomes: { type: "array", minItems: 1, maxItems: 20, items: outcomeSchema },
} as const;

const templateInputProperties = {
  name: nameSchema,
  description: { type: "string", maxLength: 20_000 },
  checklist: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 300, pattern: "\\S" } },
  values: { type: "object", maxProperties: 100, additionalProperties: fieldValueSchema },
} as const;

const invalid = (field: string, message: string): never => {
  throw new AppError(400, "validation_failed", "Invalid value", [{ field, message }]);
};

/** Исходы типа: уникальные ключи, «отменено» обязательно (отмена доступна из любого статуса). */
function checkOutcomes(outcomes: readonly Outcome[]) {
  const keys = new Set<string>();
  for (const outcome of outcomes) {
    if (keys.has(outcome.key)) invalid("outcomes", `duplicate outcome "${outcome.key}"`);
    keys.add(outcome.key);
  }
  if (!keys.has(CANCELLED_OUTCOME)) invalid("outcomes", 'the outcome "cancelled" is required');
  return outcomes.map((outcome) => ({ key: outcome.key, label: outcome.label.trim() }));
}

/** Исходы, на которые ссылаются статусы схем типа. */
function outcomesInUse(db: Database, typeId: string) {
  const rows = db
    .prepare("SELECT s.outcomes FROM scheme_statuses s JOIN status_schemes c ON c.id = s.scheme_id WHERE c.type_id = ?")
    .all(typeId) as { outcomes: string }[];
  return [...new Set(rows.flatMap((row) => json<string[]>(row.outcomes, [])))];
}

/** Новому типу — простая схема по умолчанию: Backlog → In Progress → Done. */
function createDefaultScheme(db: Database, typeId: string, now: number, outcomes: readonly string[]) {
  const schemeId = randomUUID();
  db.prepare(
    "INSERT INTO status_schemes (id, type_id, space_id, strict_order, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)",
  ).run(schemeId, typeId, now, now);
  const insert = db.prepare(
    "INSERT INTO scheme_statuses (id, scheme_id, name, category, outcomes, position) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run(randomUUID(), schemeId, "Backlog", "queue", "[]", 0);
  insert.run(randomUUID(), schemeId, "In Progress", "in_progress", "[]", 1);
  insert.run(randomUUID(), schemeId, "Done", "done", JSON.stringify(outcomes), 2);
}

/** Может ли тип быть родителем в пространстве: ограничитель действует, только если пространство его включило. */
export function canBeParent(enforced: boolean, childAllowedParents: readonly string[], parentTypeId: string) {
  return !enforced || childAllowedParents.length === 0 || childAllowedParents.includes(parentTypeId);
}

export function typeService(db: Database) {
  const fields = fieldService(db);
  const scales = scaleService(db);

  function hydrate(viewer: UserRow, rows: TypeRow[]): TicketType[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const marks = placeholders(ids);
    const typeFields = db
      .prepare(
        `SELECT tf.type_id AS typeId, tf.field_id AS fieldId FROM ticket_type_fields tf JOIN ticket_fields f ON f.id = tf.field_id
         WHERE tf.type_id IN (${marks}) AND ${visibleSql(viewer, "f.is_test")} ORDER BY tf.position`,
      )
      .all(...ids) as { typeId: string; fieldId: string }[];
    const parents = db
      .prepare(
        `SELECT p.type_id AS typeId, p.parent_type_id AS parentId FROM ticket_type_parents p JOIN ticket_types t ON t.id = p.parent_type_id
         WHERE p.type_id IN (${marks}) AND ${visibleSql(viewer, "t.is_test")} ORDER BY t.name COLLATE NOCASE`,
      )
      .all(...ids) as { typeId: string; parentId: string }[];
    const templates = db
      .prepare(
        `SELECT id, type_id AS typeId, name FROM ticket_templates WHERE type_id IN (${marks}) AND ${visibleSql(viewer)}
         ORDER BY position, name COLLATE NOCASE`,
      )
      .all(...ids) as { id: string; typeId: string; name: string }[];
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      color: row.color,
      icon: row.icon,
      fieldIds: typeFields.filter((item) => item.typeId === row.id).map((item) => item.fieldId),
      rollups: { ...DEFAULT_ROLLUPS, ...json<Partial<RollupSettings>>(row.rollups, {}) },
      outcomes: json<Outcome[]>(row.outcomes, DEFAULT_OUTCOMES),
      allowedParentTypeIds: parents.filter((item) => item.typeId === row.id).map((item) => item.parentId),
      templates: templates.filter((item) => item.typeId === row.id).map(({ id, name }) => ({ id, name })),
      system: row.is_system === 1,
    }));
  }

  const select = "SELECT id, key, name, color, icon, rollups, outcomes, is_system FROM ticket_types";

  function requireIds(viewer: UserRow, table: string, ids: readonly string[], field: string) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return unique;
    const found = db
      .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders(unique)}) AND ${visibleSql(viewer)}`)
      .all(...unique) as { id: string }[];
    if (found.length !== unique.length) invalid(field, "contains an unknown id");
    return unique;
  }

  function writeLinks(viewer: UserRow, typeId: string, input: Partial<TicketTypeInput>) {
    if (input.fieldIds) {
      const ids = requireIds(viewer, "ticket_fields", input.fieldIds, "fieldIds");
      db.prepare("DELETE FROM ticket_type_fields WHERE type_id = ?").run(typeId);
      const insert = db.prepare("INSERT INTO ticket_type_fields (type_id, field_id, position) VALUES (?, ?, ?)");
      ids.forEach((fieldId, position) => insert.run(typeId, fieldId, position));
    }
    if (input.allowedParentTypeIds) {
      const ids = requireIds(viewer, "ticket_types", input.allowedParentTypeIds, "allowedParentTypeIds");
      db.prepare("DELETE FROM ticket_type_parents WHERE type_id = ?").run(typeId);
      const insert = db.prepare("INSERT INTO ticket_type_parents (type_id, parent_type_id) VALUES (?, ?)");
      for (const parentId of ids) insert.run(typeId, parentId);
    }
  }

  // ---- проверка значений полей в шаблоне ----

  function checkValue(viewer: UserRow, field: TicketField, value: FieldValue, path: string): FieldValue {
    if (value === null || value === "") return null;
    const ids = (raw: FieldValue, multiple: boolean) => {
      const list = Array.isArray(raw) ? raw : [raw];
      if (!list.every((item) => typeof item === "string")) invalid(path, "expected ids");
      if (!multiple && list.length > 1) invalid(path, "only one value is allowed");
      return list as string[];
    };
    switch (field.kind) {
      case "text":
        return typeof value === "string" ? value : invalid(path, "expected text");
      case "number":
        return typeof value === "number" && Number.isFinite(value) ? value : invalid(path, "expected a number");
      case "date":
        return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
          ? value
          : invalid(path, "expected a date YYYY-MM-DD");
      case "list": {
        const chosen = ids(value, field.multiple);
        if (!chosen.every((id) => field.options.some((option) => option.id === id)))
          invalid(path, "unknown list value");
        return field.multiple ? chosen : (chosen[0] ?? null);
      }
      case "person": {
        const chosen = ids(value, field.multiple);
        const found = db
          .prepare(
            `SELECT id FROM users WHERE id IN (${placeholders(chosen)}) AND deactivated_at IS NULL AND ${visibleSql(viewer)}`,
          )
          .all(...chosen);
        if (found.length !== new Set(chosen).size) invalid(path, "unknown or deactivated person");
        return field.multiple ? chosen : (chosen[0] ?? null);
      }
      case "estimate": {
        const scale = scales.get(viewer, field.scaleId as string);
        if (scale.kind === "numeric") {
          return typeof value === "number" && value >= 0
            ? value
            : invalid(path, `expected a number of ${scale.unit ?? "units"}`);
        }
        return typeof value === "string" && scale.values.some((item) => item.id === value)
          ? value
          : invalid(path, `expected a value of the scale ${scale.name}`);
      }
      case "dimension": {
        const dimension = db
          .prepare("SELECT kind, source, multiple FROM dimensions WHERE id = ?")
          .get(field.dimensionId) as { kind: string; source: string | null; multiple: number } | undefined;
        if (!dimension) return invalid(path, "unknown dimension");
        const chosen = ids(value, dimension.multiple === 1);
        const table =
          dimension.kind === "list" ? "dimension_options" : dimension.source === "guilds" ? "guilds" : "feature_teams";
        const scope = dimension.kind === "list" ? "dimension_id = ?" : visibleSql(viewer);
        const found = db
          .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders(chosen)}) AND ${scope}`)
          .all(...chosen, ...(dimension.kind === "list" ? [field.dimensionId] : []));
        if (found.length !== new Set(chosen).size) invalid(path, "unknown dimension value");
        return dimension.multiple === 1 ? chosen : (chosen[0] ?? null);
      }
    }
  }

  function checkValues(viewer: UserRow, typeId: string, values: Record<string, FieldValue>) {
    const type = service.get(viewer, typeId);
    const byKey = new Map(
      fields
        .list(viewer)
        .filter((field) => type.fieldIds.includes(field.id))
        .map((field) => [field.key, field]),
    );
    const result: Record<string, FieldValue> = {};
    for (const [key, value] of Object.entries(values)) {
      const field = byKey.get(key);
      if (!field) invalid(`values/${key}`, `the type ${type.name} has no field "${key}"`);
      const checked = checkValue(viewer, field as TicketField, value, `values/${key}`);
      if (checked !== null) result[key] = checked;
    }
    return result;
  }

  function hydrateTemplate(row: TemplateRow): TicketTemplate {
    // Значения полей, убранных из типа, скрываются, но не стираются (как у тикетов, R-2.7).
    const keys = new Set(
      (
        db
          .prepare(
            "SELECT f.key FROM ticket_type_fields tf JOIN ticket_fields f ON f.id = tf.field_id WHERE tf.type_id = ?",
          )
          .all(row.type_id) as { key: string }[]
      ).map((item) => item.key),
    );
    const values = json<Record<string, FieldValue>>(row.field_values, {});
    return {
      id: row.id,
      typeId: row.type_id,
      name: row.name,
      description: row.description,
      checklist: json<string[]>(row.checklist, []),
      values: Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key))),
      system: row.is_system === 1,
    };
  }

  const templateSelect =
    "SELECT id, type_id, name, description, checklist, field_values, is_system FROM ticket_templates";

  const service = {
    list(viewer: UserRow) {
      return hydrate(
        viewer,
        db
          .prepare(`${select} WHERE ${visibleSql(viewer)} ORDER BY is_system DESC, created_at, rowid`)
          .all() as TypeRow[],
      );
    },
    get(viewer: UserRow, id: string) {
      const row = db.prepare(`${select} WHERE id = ? AND ${visibleSql(viewer)}`).get(id) as TypeRow | undefined;
      if (!row) throw new AppError(404, "not_found", "Ticket type not found");
      return hydrate(viewer, [row])[0] as TicketType;
    },
    create(viewer: UserRow, input: TicketTypeInput) {
      const id = randomUUID();
      const now = Date.now();
      const key = systemKey(input.name, input.key, "type");
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO ticket_types (id, key, name, color, icon, rollups, outcomes, is_system, is_test, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          ).run(
            id,
            key,
            input.name.trim(),
            input.color.toUpperCase(),
            input.icon,
            JSON.stringify({ ...DEFAULT_ROLLUPS, ...input.rollups }),
            JSON.stringify(checkOutcomes(input.outcomes ?? DEFAULT_OUTCOMES)),
            createdAsTest(viewer),
            now,
            now,
          );
          writeLinks(viewer, id, input);
          createDefaultScheme(
            db,
            id,
            now,
            checkOutcomes(input.outcomes ?? DEFAULT_OUTCOMES).map((item) => item.key),
          );
        })();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, "conflict", `A type named "${input.name.trim()}" or "${key}" already exists`);
        throw error;
      }
      return service.get(viewer, id);
    },
    update(viewer: UserRow, id: string, patch: Partial<TicketTypeInput>) {
      const current = service.get(viewer, id);
      try {
        db.transaction(() => {
          const sets: [string, unknown][] = [];
          if (patch.name !== undefined) sets.push(["name", patch.name.trim()]);
          if (patch.color !== undefined) sets.push(["color", patch.color.toUpperCase()]);
          if (patch.icon !== undefined) sets.push(["icon", patch.icon]);
          if (patch.rollups !== undefined)
            sets.push(["rollups", JSON.stringify({ ...current.rollups, ...patch.rollups })]);
          if (patch.outcomes !== undefined) {
            const outcomes = checkOutcomes(patch.outcomes);
            const used = outcomesInUse(db, id).filter((key) => !outcomes.some((outcome) => outcome.key === key));
            if (used.length) {
              throw new AppError(409, "conflict", `Outcomes used by statuses cannot be removed: ${used.join(", ")}`);
            }
            sets.push(["outcomes", JSON.stringify(outcomes)]);
          }
          sets.push(["updated_at", Date.now()]);
          db.prepare(`UPDATE ticket_types SET ${sets.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`).run(
            ...sets.map(([, value]) => value),
            id,
          );
          writeLinks(viewer, id, patch);
          // Новые настройки свёрток сразу действуют на тикеты типа и их предков (R-2.12, docs/adr/0016).
          if (patch.rollups !== undefined) rollupService(db, treeStore(db), historyService(db)).recomputeType(id);
        })();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, "conflict", `A type named "${patch.name?.trim()}" already exists`);
        throw error;
      }
      return service.get(viewer, id);
    },
    /** Проверяет значения полей по набору полей типа (шаблоны, тикеты). */
    checkValues(viewer: UserRow, typeId: string, values: Record<string, FieldValue>) {
      return checkValues(viewer, typeId, values);
    },
    remove(viewer: UserRow, id: string) {
      if (service.get(viewer, id).system) throw new AppError(409, "conflict", "Start types cannot be deleted");
      if (db.prepare("SELECT 1 FROM tickets WHERE type_id = ? LIMIT 1").get(id)) {
        throw new AppError(409, "conflict", "The type has tickets; change their type first");
      }
      db.prepare("DELETE FROM ticket_types WHERE id = ?").run(id);
    },

    templates(viewer: UserRow, typeId: string) {
      service.get(viewer, typeId);
      return (
        db
          .prepare(
            `${templateSelect} WHERE type_id = ? AND ${visibleSql(viewer)} ORDER BY position, name COLLATE NOCASE`,
          )
          .all(typeId) as TemplateRow[]
      ).map((row) => hydrateTemplate(row));
    },
    template(viewer: UserRow, id: string) {
      const row = db.prepare(`${templateSelect} WHERE id = ? AND ${visibleSql(viewer)}`).get(id) as
        | TemplateRow
        | undefined;
      if (!row) throw new AppError(404, "not_found", "Template not found");
      service.get(viewer, row.type_id);
      return hydrateTemplate(row);
    },
    createTemplate(viewer: UserRow, typeId: string, input: TicketTemplateInput) {
      service.get(viewer, typeId);
      const values = checkValues(viewer, typeId, input.values ?? {});
      const id = randomUUID();
      const now = Date.now();
      const position = (
        db
          .prepare("SELECT coalesce(max(position), -1) + 1 AS next FROM ticket_templates WHERE type_id = ?")
          .get(typeId) as {
          next: number;
        }
      ).next;
      try {
        db.prepare(
          `INSERT INTO ticket_templates (id, type_id, name, description, checklist, field_values, position, is_system, is_test, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        ).run(
          id,
          typeId,
          input.name.trim(),
          input.description ?? "",
          JSON.stringify((input.checklist ?? []).map((item) => item.trim())),
          JSON.stringify(values),
          position,
          createdAsTest(viewer),
          now,
          now,
        );
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, "conflict", `The type already has a template "${input.name.trim()}"`);
        throw error;
      }
      return service.template(viewer, id);
    },
    updateTemplate(viewer: UserRow, id: string, patch: Partial<TicketTemplateInput>) {
      const current = service.template(viewer, id);
      const values = patch.values === undefined ? undefined : checkValues(viewer, current.typeId, patch.values);
      try {
        const sets: [string, unknown][] = [];
        if (patch.name !== undefined) sets.push(["name", patch.name.trim()]);
        if (patch.description !== undefined) sets.push(["description", patch.description]);
        if (patch.checklist !== undefined)
          sets.push(["checklist", JSON.stringify(patch.checklist.map((item) => item.trim()))]);
        if (values !== undefined) sets.push(["field_values", JSON.stringify(values)]);
        sets.push(["updated_at", Date.now()]);
        db.prepare(
          `UPDATE ticket_templates SET ${sets.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
        ).run(...sets.map(([, value]) => value), id);
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, "conflict", `The type already has a template "${patch.name?.trim()}"`);
        throw error;
      }
      return service.template(viewer, id);
    },
    removeTemplate(viewer: UserRow, id: string) {
      if (service.template(viewer, id).system) throw new AppError(409, "conflict", "Start templates cannot be deleted");
      db.prepare("DELETE FROM ticket_templates WHERE id = ?").run(id);
    },
  };
  return service;
}

export const typeRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  const types = typeService(db);
  const tags = ["ticket-types"];

  app.get(
    "/api/v1/ticket-types",
    {
      schema: {
        tags,
        summary: "Ticket types",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: typeSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: types.list(requireAuth(request).user) }),
  );

  app.get(
    "/api/v1/ticket-types/:id",
    {
      schema: {
        tags,
        summary: "One ticket type",
        params: idParams,
        response: { 200: typeSchema, ...problemResponses },
      },
    },
    async (request) => types.get(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.post(
    "/api/v1/ticket-types",
    {
      schema: {
        tags,
        summary: "Create a ticket type (superadmin)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "color", "icon"],
          properties: { ...typeInputProperties, key: { type: "string", maxLength: 40 } },
        },
        response: { 201: typeSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      const type = types.create(user, request.body as TicketTypeInput);
      request.log.info({ adminId: user.id, typeId: type.id }, "Ticket type created");
      return reply.code(201).send(type);
    },
  );

  app.patch(
    "/api/v1/ticket-types/:id",
    {
      schema: {
        tags,
        summary: "Change a ticket type: name, color, icon, fields, rollups, subordination (superadmin)",
        params: idParams,
        body: { type: "object", additionalProperties: false, minProperties: 1, properties: typeInputProperties },
        response: { 200: typeSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return types.update(user, (request.params as { id: string }).id, request.body as Partial<TicketTypeInput>);
    },
  );

  app.delete(
    "/api/v1/ticket-types/:id",
    {
      schema: {
        tags,
        summary: "Delete a custom ticket type (superadmin)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      types.remove(user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/ticket-types/subordination",
    {
      schema: {
        tags,
        summary: "Can a type be the parent of another in a space?",
        description:
          "Rules apply only in spaces that enabled them (off by default). Hierarchy itself arrives in YT-09.",
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["spaceId", "parentTypeId", "childTypeId"],
          properties: {
            spaceId: { type: "string", maxLength: 64 },
            parentTypeId: { type: "string", maxLength: 64 },
            childTypeId: { type: "string", maxLength: 64 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["allowed", "enforced"],
            properties: { allowed: { type: "boolean" }, enforced: { type: "boolean" } },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const query = request.query as { spaceId: string; parentTypeId: string; childTypeId: string };
      const space = requireVisibleSpace(db, user, query.spaceId);
      types.get(user, query.parentTypeId);
      const child = types.get(user, query.childTypeId);
      return {
        enforced: space.enforceSubordination,
        allowed: canBeParent(space.enforceSubordination, child.allowedParentTypeIds, query.parentTypeId),
      };
    },
  );

  // ---- шаблоны ----

  app.get(
    "/api/v1/ticket-types/:id/templates",
    {
      schema: {
        tags,
        summary: "Templates of a type",
        params: idParams,
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: templateSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: types.templates(requireAuth(request).user, (request.params as { id: string }).id) }),
  );

  app.post(
    "/api/v1/ticket-types/:id/templates",
    {
      schema: {
        tags,
        summary: "Add a template to a type (superadmin)",
        description: "Values are keyed by field system name and must fit the field kind and the type's field set.",
        params: idParams,
        body: { type: "object", additionalProperties: false, required: ["name"], properties: templateInputProperties },
        response: { 201: templateSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      const template = types.createTemplate(
        user,
        (request.params as { id: string }).id,
        request.body as TicketTemplateInput,
      );
      request.log.info({ adminId: user.id, templateId: template.id }, "Template created");
      return reply.code(201).send(template);
    },
  );

  app.get(
    "/api/v1/ticket-templates/:id",
    {
      schema: {
        tags,
        summary: "One template",
        params: idParams,
        response: { 200: templateSchema, ...problemResponses },
      },
    },
    async (request) => types.template(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.patch(
    "/api/v1/ticket-templates/:id",
    {
      schema: {
        tags,
        summary: "Change a template (superadmin)",
        params: idParams,
        body: { type: "object", additionalProperties: false, minProperties: 1, properties: templateInputProperties },
        response: { 200: templateSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      return types.updateTemplate(
        user,
        (request.params as { id: string }).id,
        request.body as Partial<TicketTemplateInput>,
      );
    },
  );

  app.delete(
    "/api/v1/ticket-templates/:id",
    {
      schema: {
        tags,
        summary: "Delete a custom template (superadmin)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireSuperadmin(request);
      types.removeTemplate(user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );
};
