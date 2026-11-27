import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  mapStatusOnTypeChange,
  RESPONSIBLE_ROLES,
  STATUS_CATEGORIES,
  validateScheme,
  type EntryRequirement,
  type StatusScheme,
  type StatusSchemeInput,
  type WorkflowStatus,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type UserRow } from "../auth/sessions.js";
import { idParams } from "../directory/common.js";
import { requireVisibleSpace } from "../spaces/routes.js";
import { json } from "./common.js";
import { typeService } from "./types.js";
import { historyService } from "../tickets/history.js";

/**
 * Схемы статусов (R-2.10, R-5.1; YT-05, docs/adr/0011). Схема — на тип; у пространства может быть своя,
 * иначе действует схема по умолчанию. Статусы сохраняют id при правке: на них ссылаются тикеты.
 */
interface StatusRow {
  id: string;
  name: string;
  category: WorkflowStatus["category"];
  waiting: number;
  outcomes: string;
  requirements: string;
  responsible_roles: string;
  freeze_requirements: number;
}

const requirementSchema = {
  type: "object",
  required: ["kind"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["field", "people", "description", "checklist_done"] },
    fieldKey: { type: "string", maxLength: 40 },
    role: { type: "string", enum: ["assignees", "customer", "tester"] },
  },
} as const;

const statusProperties = {
  id: { type: "string", maxLength: 64 },
  name: { type: "string", maxLength: 60 },
  category: { type: "string", enum: STATUS_CATEGORIES },
  waiting: { type: "boolean" },
  outcomes: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
  requirements: { type: "array", maxItems: 30, items: requirementSchema },
  responsibleRoles: { type: "array", maxItems: 4, items: { type: "string", enum: RESPONSIBLE_ROLES } },
  freezeRequirements: { type: "boolean" },
} as const;

export const schemeSchema = {
  type: "object",
  required: ["typeId", "spaceId", "inherited", "strictOrder", "statuses"],
  properties: {
    typeId: { type: "string" },
    spaceId: { type: ["string", "null"] },
    inherited: { type: "boolean" },
    strictOrder: { type: "boolean", description: "Only to the next status or back to any earlier one" },
    statuses: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "name",
          "category",
          "waiting",
          "outcomes",
          "requirements",
          "responsibleRoles",
          "freezeRequirements",
        ],
        properties: statusProperties,
      },
    },
  },
} as const;

export function schemeService(db: Database) {
  const types = typeService(db);
  const history = historyService(db);

  function schemeRow(typeId: string, spaceId: string | null) {
    return db
      .prepare(
        `SELECT id, strict_order FROM status_schemes WHERE type_id = ? AND ${spaceId === null ? "space_id IS NULL" : "space_id = ?"}`,
      )
      .get(...(spaceId === null ? [typeId] : [typeId, spaceId])) as { id: string; strict_order: number } | undefined;
  }

  function statuses(schemeId: string): WorkflowStatus[] {
    return (
      db.prepare("SELECT * FROM scheme_statuses WHERE scheme_id = ? ORDER BY position").all(schemeId) as StatusRow[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      waiting: row.waiting === 1,
      outcomes: json<string[]>(row.outcomes, []),
      requirements: json<EntryRequirement[]>(row.requirements, []),
      responsibleRoles: json<WorkflowStatus["responsibleRoles"]>(row.responsible_roles, []),
      freezeRequirements: row.freeze_requirements === 1,
    }));
  }

  /** Тикеты типа в пространстве(ах), которые смотрят на эту схему. */
  function ticketScope(typeId: string, spaceId: string | null) {
    if (spaceId !== null) return { sql: "type_id = ? AND space_id = ?", params: [typeId, spaceId] };
    return {
      sql: "type_id = ? AND space_id NOT IN (SELECT space_id FROM status_schemes WHERE type_id = ? AND space_id IS NOT NULL)",
      params: [typeId, typeId],
    };
  }

  /** Переносит тикеты со старых статусов на новые по правилу смены типа: имя, категория, первый подходящий. */
  function remapTickets(typeId: string, spaceId: string | null, from: WorkflowStatus[], to: WorkflowStatus[]) {
    const scope = ticketScope(typeId, spaceId);
    for (const status of from) {
      if (to.some((item) => item.id === status.id)) continue;
      const mapping = mapStatusOnTypeChange(status, to);
      const target = mapping.kind === "ask" ? mapping.candidates[0] : mapping.statusId;
      if (!target) continue;
      const done = to.find((item) => item.id === target)?.category === "done";
      const moved = db
        .prepare(`SELECT id FROM tickets WHERE status_id = ? AND ${scope.sql}`)
        .all(status.id, ...scope.params) as { id: string }[];
      db.prepare(
        `UPDATE tickets SET status_id = ?, outcome = CASE WHEN ? THEN outcome ELSE NULL END, version = version + 1
         WHERE status_id = ? AND ${scope.sql}`,
      ).run(target, done ? 1 : 0, status.id, ...scope.params);
      // Перенос — изменение тикета: пишем в журнал от имени системы (R-2.25). «Было» — из старой схемы:
      // имена в базе на этот момент уже временно подменены.
      const from = {
        raw: { id: status.id, name: status.name, category: status.category },
        text: status.name,
      };
      for (const ticket of moved) {
        history.record(ticket.id, { id: null, name: null, source: "system", detail: "status scheme changed" }, [
          { field: "status", from, to: history.statusValue(target) },
        ]);
      }
    }
  }

  const service = {
    /** Действующая схема: своя у пространства или по умолчанию. */
    get(viewer: UserRow, typeId: string, spaceId: string | null): StatusScheme {
      types.get(viewer, typeId);
      const own = spaceId === null ? undefined : schemeRow(typeId, spaceId);
      const row = own ?? schemeRow(typeId, null);
      if (!row) throw new AppError(404, "not_found", "The type has no status scheme");
      return {
        typeId,
        spaceId,
        inherited: spaceId !== null && !own,
        strictOrder: row.strict_order === 1,
        statuses: statuses(row.id),
      };
    },

    put(viewer: UserRow, typeId: string, input: StatusSchemeInput) {
      const type = types.get(viewer, typeId);
      const spaceId = input.spaceId ?? null;
      const problems = validateScheme(input, type.outcomes);
      const fieldKeys = new Set(
        (
          db
            .prepare(
              "SELECT f.key FROM ticket_type_fields tf JOIN ticket_fields f ON f.id = tf.field_id WHERE tf.type_id = ?",
            )
            .all(typeId) as { key: string }[]
        ).map((row) => row.key),
      );
      input.statuses.forEach((status, index) => {
        status.requirements.forEach((requirement, position) => {
          const field = `statuses/${index}/requirements/${position}`;
          if (requirement.kind === "field" && !fieldKeys.has(requirement.fieldKey ?? "")) {
            problems.push({ field, message: `the type has no field "${requirement.fieldKey ?? ""}"` });
          }
          if (requirement.kind === "people" && !requirement.role) problems.push({ field, message: "choose a role" });
        });
      });
      if (problems.length) throw new AppError(400, "validation_failed", "The status scheme is invalid", problems);

      const before = service.get(viewer, typeId, spaceId);
      const now = Date.now();
      db.transaction(() => {
        let row = schemeRow(typeId, spaceId);
        if (!row) {
          const id = randomUUID();
          db.prepare(
            "INSERT INTO status_schemes (id, type_id, space_id, strict_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
          ).run(id, typeId, spaceId, now, now);
          row = { id, strict_order: 0 };
        }
        const schemeId = row.id;
        const existing = new Set(statuses(schemeId).map((status) => status.id));
        const kept = new Set<string>();
        const saved: WorkflowStatus[] = input.statuses.map((status) => {
          // Свой id статус сохраняет только в своей схеме; новая схема пространства получает новые id.
          const id = status.id && existing.has(status.id) ? status.id : randomUUID();
          kept.add(id);
          return {
            id,
            name: status.name.trim(),
            category: status.category,
            waiting: status.waiting,
            outcomes: status.category === "done" ? [...new Set(status.outcomes)] : [],
            requirements: status.requirements.map((requirement) =>
              requirement.kind === "field"
                ? { kind: "field", fieldKey: requirement.fieldKey }
                : requirement.kind === "people"
                  ? { kind: "people", role: requirement.role }
                  : { kind: requirement.kind },
            ) as EntryRequirement[],
            responsibleRoles: [...new Set(status.responsibleRoles)],
            freezeRequirements: status.freezeRequirements,
          };
        });
        // Сначала уводим старые имена, чтобы не упереться в уникальность при перестановке.
        db.prepare("UPDATE scheme_statuses SET name = id, position = position + 10000 WHERE scheme_id = ?").run(
          schemeId,
        );
        const upsert = db.prepare(
          `INSERT INTO scheme_statuses (id, scheme_id, name, category, waiting, outcomes, requirements, responsible_roles, freeze_requirements, position)
           VALUES (@id, @schemeId, @name, @category, @waiting, @outcomes, @requirements, @roles, @freeze, @position)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, waiting = excluded.waiting,
             outcomes = excluded.outcomes, requirements = excluded.requirements, responsible_roles = excluded.responsible_roles,
             freeze_requirements = excluded.freeze_requirements, position = excluded.position`,
        );
        saved.forEach((status, position) =>
          upsert.run({
            id: status.id,
            schemeId,
            name: status.name,
            category: status.category,
            waiting: Number(status.waiting),
            outcomes: JSON.stringify(status.outcomes),
            requirements: JSON.stringify(status.requirements),
            roles: JSON.stringify(status.responsibleRoles),
            freeze: Number(status.freezeRequirements),
            position,
          }),
        );
        remapTickets(typeId, spaceId, before.statuses, saved);
        for (const id of existing) if (!kept.has(id)) db.prepare("DELETE FROM scheme_statuses WHERE id = ?").run(id);
        db.prepare("UPDATE status_schemes SET strict_order = ?, updated_at = ? WHERE id = ?").run(
          Number(input.strictOrder),
          now,
          schemeId,
        );
      })();
      return service.get(viewer, typeId, spaceId);
    },

    /** Убирает схему пространства: снова действует схема по умолчанию, тикеты переносятся по имени. */
    reset(viewer: UserRow, typeId: string, spaceId: string) {
      const own = schemeRow(typeId, spaceId);
      if (!own) return service.get(viewer, typeId, spaceId);
      const before = statuses(own.id);
      const fallback = service.get(viewer, typeId, null).statuses;
      db.transaction(() => {
        remapTickets(typeId, spaceId, before, fallback);
        db.prepare("DELETE FROM status_schemes WHERE id = ?").run(own.id);
      })();
      return service.get(viewer, typeId, spaceId);
    },
  };
  return service;
}

export const schemeRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  const schemes = schemeService(db);
  const tags = ["ticket-types"];
  const spaceQuery = {
    type: "object",
    additionalProperties: false,
    properties: { spaceId: { type: "string", maxLength: 64 } },
  } as const;
  const spaceOf = (user: UserRow, spaceId: string | undefined) =>
    spaceId ? requireVisibleSpace(db, user, spaceId).id : null;

  app.get(
    "/api/v1/ticket-types/:id/scheme",
    {
      schema: {
        tags,
        summary: "Status scheme of a type: the space's own or the default one",
        params: idParams,
        querystring: spaceQuery,
        response: { 200: schemeSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const { spaceId } = request.query as { spaceId?: string };
      return schemes.get(user, (request.params as { id: string }).id, spaceOf(user, spaceId));
    },
  );

  app.put(
    "/api/v1/ticket-types/:id/scheme",
    {
      schema: {
        tags,
        summary: "Replace a status scheme (superadmin)",
        description:
          "Every status needs a category; a done status needs at least one outcome; one done status must allow " +
          '"cancelled". Keep a status id to keep tickets on it; removed statuses move their tickets by name, then category.',
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["strictOrder", "statuses"],
          properties: {
            spaceId: { type: ["string", "null"], maxLength: 64 },
            strictOrder: { type: "boolean" },
            statuses: {
              type: "array",
              maxItems: 50,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "waiting", "outcomes", "requirements", "responsibleRoles", "freezeRequirements"],
                properties: statusProperties,
              },
            },
          },
        },
        response: { 200: schemeSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      const input = request.body as StatusSchemeInput;
      const spaceId = spaceOf(user, input.spaceId ?? undefined);
      const scheme = schemes.put(user, (request.params as { id: string }).id, { ...input, spaceId });
      request.log.info({ adminId: user.id, typeId: scheme.typeId, spaceId }, "Status scheme saved");
      return scheme;
    },
  );

  app.delete(
    "/api/v1/ticket-types/:id/scheme",
    {
      schema: {
        tags,
        summary: "Drop a space's own scheme; the default one applies again (superadmin)",
        params: idParams,
        querystring: { ...spaceQuery, required: ["spaceId"] },
        response: { 200: schemeSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      const { spaceId } = request.query as { spaceId: string };
      return schemes.reset(user, (request.params as { id: string }).id, requireVisibleSpace(db, user, spaceId).id);
    },
  );
};
