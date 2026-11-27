import type { FastifyPluginAsync } from "fastify";
import {
  type BulkEditInput,
  ARCHIVE_REASONS,
  PRIORITIES,
  VISIBILITIES,
  type ArchiveReason,
  type MoveInput,
  type TicketCreateInput,
  type TicketPatch,
  type VisibilityInput,
  type WrapInput,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { problemResponses } from "../errors.js";
import { requireAuth } from "../auth/sessions.js";
import { nameSchema, personRefSchema } from "../directory/common.js";
import { hierarchyService } from "./hierarchy.js";
import { ticketService } from "./service.js";
import { tqlService } from "./tql.js";

const nullableString = { type: ["string", "null"] } as const;
const date = { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const fieldValue = {
  anyOf: [
    { type: "null" },
    { type: "number" },
    { type: "string", maxLength: 5000 },
    { type: "array", maxItems: 200, items: { type: "string", maxLength: 64 } },
  ],
} as const;
const checklistItem = {
  type: "object",
  additionalProperties: false,
  required: ["text", "done"],
  properties: {
    id: { type: "string", maxLength: 64 },
    text: { type: "string", maxLength: 500 },
    done: { type: "boolean" },
    childKey: { anyOf: [{ type: "null" }, { type: "string", maxLength: 40 }] },
  },
} as const;

const loose = { type: "object", additionalProperties: true } as const;
const progressSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      required: ["done", "total", "percent"],
      properties: { done: { type: "number" }, total: { type: "number" }, percent: { type: "integer" } },
    },
  ],
} as const;

const ticketSchema = {
  type: "object",
  required: ["id", "key", "number", "spaceId", "typeId", "statusId", "title", "version"],
  properties: {
    id: { type: "string" },
    key: { type: "string", description: "AOS-N: system-wide, never changes, never reused" },
    legacyNumber: { type: ["string", "null"], description: "Old Taiga number, read-only; filled by the import" },
    number: { type: "integer" },
    spaceId: { type: "string" },
    typeId: { type: "string" },
    statusId: { type: "string" },
    outcome: nullableString,
    title: { type: "string" },
    description: { type: "string", description: "Markdown" },
    checklist: { type: "array", items: { ...checklistItem, required: ["id", "text", "done"] } },
    values: { type: "object", additionalProperties: fieldValue },
    priority: { type: "string", enum: PRIORITIES },
    tags: { type: "array", items: { type: "string" } },
    startDate: nullableString,
    endDate: nullableString,
    blocked: { type: "boolean" },
    blockedReason: nullableString,
    cancelReason: nullableString,
    archived: {
      anyOf: [
        {
          type: "object",
          required: ["reason", "at"],
          properties: { reason: { type: "string", enum: ARCHIVE_REASONS }, at: { type: "string" } },
        },
        { type: "null" },
      ],
    },
    people: {
      type: "object",
      properties: {
        assignees: { type: "array", items: personRefSchema },
        customer: { anyOf: [personRefSchema, { type: "null" }] },
        tester: { anyOf: [personRefSchema, { type: "null" }] },
        watchers: { type: "array", items: personRefSchema },
      },
    },
    version: { type: "integer", description: "Send it back with every change; a stale version gets version_conflict" },
    createdBy: { anyOf: [personRefSchema, { type: "null" }] },
    updatedBy: { anyOf: [personRefSchema, { type: "null" }] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    visibility: { ...loose, description: "Own and effective visibility, access list (R-2.20)" },
    numbers: {
      type: "array",
      description:
        "Flow numbers (R-2.9): one per path; parentKey is the direct parent on the path. Never use them in links",
      items: {
        type: "object",
        required: ["number", "parentKey"],
        properties: { number: { type: "string" }, parentKey: { anyOf: [{ type: "string" }, { type: "null" }] } },
      },
    },
    permissions: { ...loose, description: "What the viewer may do: for buttons; the server decides anyway" },
    masked: {
      type: "array",
      items: { type: "string" },
      description: "Fields hidden from the viewer by the field mask",
    },
    relations: { ...loose, description: "Parents, children (unavailable ones without key and title), coverage" },
    rollup: { ...loose, description: "Progress, dates and estimates by children; «all children closed» flag (R-2.12)" },
  },
} as const;

const summarySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    title: { type: "string" },
    typeId: { type: "string" },
    statusId: { type: "string" },
    outcome: nullableString,
    priority: { type: "string" },
    assignees: { type: "array", items: personRefSchema },
    blocked: { type: "boolean" },
    archived: { type: "boolean" },
    updatedAt: { type: "string" },
    titleOnly: { type: "boolean", description: "Only the title and progress are open to the viewer" },
    progress: progressSchema,
    coverage: { type: "integer", description: "How many goals are among the ancestors" },
    numbers: { type: "array", items: { type: "string" }, description: "Flow numbers like 1.3.2, one per path (R-2.9)" },
  },
} as const;

const keyParams = {
  type: "object",
  required: ["key"],
  properties: { key: { type: "string", maxLength: 64, description: "Ticket key (AOS-12) or id" } },
} as const;
const version = { type: "integer", minimum: 1 } as const;
const withVersion = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  required: ["version", ...required],
  properties: { version, ...properties },
});

/**
 * Тикеты (YT-06, docs/adr/0012). Видны участникам пространства и суперадмину.
 * Каждое изменение несёт `version`; устаревшая версия → 409 version_conflict с актуальным тикетом в `current`.
 */
export const ticketRoutes: FastifyPluginAsync<{ db: Database; keyPrefix: string }> = async (app, { db, keyPrefix }) => {
  const tickets = ticketService(db, keyPrefix);
  const tql = tqlService(db, tickets);
  const hierarchy = hierarchyService(db, tickets);
  const tags = ["tickets"];
  const one = { 200: ticketSchema, ...problemResponses };
  const keyOf = (request: { params: unknown }) => (request.params as { key: string }).key;

  app.get(
    "/api/v1/tickets",
    {
      schema: {
        tags,
        summary: "Tickets of a space. Archived ones are hidden unless asked for.",
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["spaceId"],
          properties: {
            spaceId: { type: "string", maxLength: 64 },
            archived: { type: "string", enum: ["exclude", "include", "only"], default: "exclude" },
            q: { type: "string", maxLength: 4000, description: "TQL or plain words (full text)" },
            sort: { type: "string", enum: ["number", "coverage", "flow"], default: "number" },
            minCoverage: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: summarySchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const viewer = requireAuth(request).user;
      const query = request.query as {
        spaceId: string;
        archived: "exclude" | "include" | "only";
        q?: string;
        sort?: "number" | "coverage" | "flow";
        minCoverage?: number;
      };
      const { q, ...rest } = query;
      // Строка поиска — тот же разборщик TQL, что и везде (R-2.28): слова — полнотекст, иначе запрос.
      const only = q?.trim()
        ? new Set(tql.match(viewer, tql.parse(q), { spaceId: query.spaceId, archived: query.archived }).ids)
        : undefined;
      return { items: tickets.list(viewer, { ...rest, ...(only ? { only } : {}) }) };
    },
  );

  app.post(
    "/api/v1/tickets",
    {
      schema: {
        tags,
        summary: "Create a ticket: from a template, or in one line (title + type)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["spaceId", "typeId", "title"],
          properties: {
            spaceId: { type: "string", maxLength: 64 },
            typeId: { type: "string", maxLength: 64 },
            title: { ...nameSchema, maxLength: 500 },
            templateId: { type: "string", maxLength: 64 },
            parentKey: { type: "string", maxLength: 40, description: "Create as a child of this ticket («+ child»)" },
            childKey: { type: "string", maxLength: 40, description: "Create as a parent of this ticket («+ parent»)" },
            beforeKey: {
              type: "string",
              maxLength: 40,
              description: "With parentKey: insert before this child; flow numbers shift (R-2.9)",
            },
          },
        },
        response: { 201: ticketSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireAuth(request);
      const ticket = tickets.create(user, request.body as TicketCreateInput);
      request.log.info({ userId: user.id, ticket: ticket.key }, "Ticket created");
      return reply.code(201).send(ticket);
    },
  );

  app.get(
    "/api/v1/tickets/:key",
    { schema: { tags, summary: "One ticket by key or id", params: keyParams, response: one } },
    async (request) => tickets.get(requireAuth(request).user, keyOf(request)),
  );

  app.patch(
    "/api/v1/tickets/:key",
    {
      schema: {
        tags,
        summary: "Change title, description, checklist, fields, people, priority, tags, dates, blocked flag",
        params: keyParams,
        body: withVersion({
          title: { ...nameSchema, maxLength: 500 },
          description: { type: "string", maxLength: 100_000 },
          checklist: { type: "array", maxItems: 300, items: checklistItem },
          values: { type: "object", maxProperties: 100, additionalProperties: fieldValue },
          priority: { type: "string", enum: PRIORITIES },
          tags: { type: "array", maxItems: 50, items: { type: "string", maxLength: 60 } },
          startDate: date,
          endDate: date,
          blocked: { type: "boolean" },
          blockedReason: { type: ["string", "null"], maxLength: 500 },
          people: {
            type: "object",
            additionalProperties: false,
            properties: {
              assigneeIds: { type: "array", maxItems: 50, items: { type: "string", maxLength: 64 } },
              customerId: { type: ["string", "null"], maxLength: 64 },
              testerId: { type: ["string", "null"], maxLength: 64 },
              watcherIds: { type: "array", maxItems: 200, items: { type: "string", maxLength: 64 } },
            },
          },
        }),
        response: one,
      },
    },
    async (request) => tickets.update(requireAuth(request).user, keyOf(request), request.body as TicketPatch),
  );

  app.post(
    "/api/v1/tickets/:key/assign-me",
    { schema: { tags, summary: "Add me to the assignees", params: keyParams, body: withVersion({}), response: one } },
    async (request) =>
      tickets.assignMe(requireAuth(request).user, keyOf(request), (request.body as { version: number }).version),
  );

  app.post(
    "/api/v1/tickets/:key/transition",
    {
      schema: {
        tags,
        summary: "Change status by the scheme rules",
        description:
          "Fails with transition_blocked (422) listing what the target status requires, or when a strict order forbids the move. " +
          "A done status needs an outcome; cancelling has its own action.",
        params: keyParams,
        body: withVersion({ statusId: { type: "string", maxLength: 64 }, outcome: { type: "string", maxLength: 40 } }, [
          "statusId",
        ]),
        response: one,
      },
    },
    async (request) =>
      tickets.transition(
        requireAuth(request).user,
        keyOf(request),
        request.body as { version: number; statusId: string; outcome?: string },
      ),
  );

  app.post(
    "/api/v1/tickets/:key/cancel",
    {
      schema: {
        tags,
        summary: "Cancel from any status: Done with the outcome «cancelled» and a reason",
        params: keyParams,
        body: withVersion({ reason: { type: "string", maxLength: 1000 } }, ["reason"]),
        response: one,
      },
    },
    async (request) =>
      tickets.cancel(requireAuth(request).user, keyOf(request), request.body as { version: number; reason: string }),
  );

  app.post(
    "/api/v1/tickets/:key/archive",
    {
      schema: {
        tags,
        summary: "Archive with a reason; the status is kept",
        params: keyParams,
        body: withVersion({ reason: { type: "string", enum: ARCHIVE_REASONS } }, ["reason"]),
        response: one,
      },
    },
    async (request) =>
      tickets.archive(
        requireAuth(request).user,
        keyOf(request),
        request.body as { version: number; reason: ArchiveReason },
      ),
  );

  app.post(
    "/api/v1/tickets/:key/unarchive",
    {
      schema: {
        tags,
        summary: "Return from the archive with the previous status",
        params: keyParams,
        body: withVersion({}),
        response: one,
      },
    },
    async (request) =>
      tickets.unarchive(requireAuth(request).user, keyOf(request), (request.body as { version: number }).version),
  );

  app.post(
    "/api/v1/tickets/:key/change-type",
    {
      schema: {
        tags,
        summary: "Change the type; the status moves by name, then category, otherwise you are asked",
        description:
          "When several statuses fit, the answer is status_choice_required (409) with `candidates`; repeat with statusId.",
        params: keyParams,
        body: withVersion({ typeId: { type: "string", maxLength: 64 }, statusId: { type: "string", maxLength: 64 } }, [
          "typeId",
        ]),
        response: one,
      },
    },
    async (request) =>
      tickets.changeType(
        requireAuth(request).user,
        keyOf(request),
        request.body as { version: number; typeId: string; statusId?: string },
      ),
  );

  // ---- видимость (YT-08) ----

  app.put(
    "/api/v1/tickets/:key/visibility",
    {
      schema: {
        tags,
        summary:
          "Visibility: open, title only, hidden, or inherit (null). Inherited down the branch; an explicit child setting wins",
        params: keyParams,
        body: withVersion(
          {
            visibility: { anyOf: [{ type: "null" }, { type: "string", enum: VISIBILITIES }] },
            allow: {
              type: "array",
              maxItems: 200,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "id"],
                properties: {
                  kind: { type: "string", enum: ["person", "team", "guild"] },
                  id: { type: "string", maxLength: 64 },
                },
              },
            },
          },
          ["visibility"],
        ),
        response: one,
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return tickets.setVisibility(auth.user, auth.realUser, keyOf(request), request.body as VisibilityInput);
    },
  );

  // ---- иерархия (YT-09) ----

  app.post(
    "/api/v1/tickets/:key/parents",
    {
      schema: {
        tags,
        summary: "Add a parent. Cycles are refused (hierarchy_cycle); type rules are checked (subordination_violation)",
        params: keyParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["parentKey"],
          properties: { parentKey: { type: "string", maxLength: 40 } },
        },
        response: one,
      },
    },
    async (request) =>
      hierarchy.addParent(requireAuth(request).user, keyOf(request), (request.body as { parentKey: string }).parentKey),
  );

  app.delete(
    "/api/v1/tickets/:key/parents/:parentKey",
    {
      schema: {
        tags,
        summary: "Remove one parent link; other parents stay",
        params: {
          type: "object",
          required: ["key", "parentKey"],
          properties: { key: { type: "string", maxLength: 64 }, parentKey: { type: "string", maxLength: 40 } },
        },
        response: one,
      },
    },
    async (request) =>
      hierarchy.removeParent(
        requireAuth(request).user,
        keyOf(request),
        (request.params as { parentKey: string }).parentKey,
      ),
  );

  app.post(
    "/api/v1/tickets/bulk",
    {
      schema: {
        tags,
        summary:
          "Bulk edit: status by name, priority, assignees, watchers — all or nothing. " +
          "Notifications: one message per recipient for the whole operation",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["keys"],
          properties: {
            keys: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", maxLength: 40 } },
            status: { type: "string", maxLength: 120 },
            outcome: { type: "string", maxLength: 64 },
            priority: { type: "string", enum: ["highest", "high", "normal", "low", "lowest"] },
            assigneeIds: { type: "array", maxItems: 50, items: { type: "string", maxLength: 64 } },
            watcherIds: { type: "array", maxItems: 50, items: { type: "string", maxLength: 64 } },
          },
        },
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: ticketSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: tickets.bulk(requireAuth(request).user, request.body as BulkEditInput) }),
  );

  app.post(
    "/api/v1/tickets/move",
    {
      schema: {
        tags,
        summary: "Bulk change of parent / branch move in one operation; also the order among children (beforeKey)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["keys", "toParentKey"],
          properties: {
            keys: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", maxLength: 40 } },
            fromParentKey: { anyOf: [{ type: "null" }, { type: "string", maxLength: 40 }] },
            toParentKey: { anyOf: [{ type: "null" }, { type: "string", maxLength: 40 }] },
            beforeKey: { anyOf: [{ type: "null" }, { type: "string", maxLength: 40 }] },
          },
        },
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: ticketSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => hierarchy.move(requireAuth(request).user, request.body as MoveInput),
  );

  app.post(
    "/api/v1/tickets/wrap",
    {
      schema: {
        tags,
        summary: "Wrap in a parent: a new ticket goes between the tickets and their parent (or above them)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["keys", "title", "typeId"],
          properties: {
            keys: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", maxLength: 40 } },
            fromParentKey: { anyOf: [{ type: "null" }, { type: "string", maxLength: 40 }] },
            title: { ...nameSchema, maxLength: 500 },
            typeId: { type: "string", maxLength: 64 },
            spaceId: { type: "string", maxLength: 64 },
          },
        },
        response: { 201: ticketSchema, ...problemResponses },
      },
    },
    async (request, reply) =>
      reply.code(201).send(hierarchy.wrap(requireAuth(request).user, request.body as WrapInput)),
  );

  app.get(
    "/api/v1/tree",
    {
      schema: {
        tags,
        summary:
          "The tree of a space or a branch. A shared ticket is listed under each parent; unavailable ones have no key or title",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { spaceId: { type: "string", maxLength: 64 }, rootKey: { type: "string", maxLength: 40 } },
        },
        response: {
          200: {
            type: "object",
            required: ["nodes", "roots", "children"],
            properties: {
              nodes: { type: "object", additionalProperties: loose },
              roots: { type: "array", items: { type: "string" } },
              children: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) =>
      hierarchy.tree(requireAuth(request).user, request.query as { spaceId?: string; rootKey?: string }),
  );
};
