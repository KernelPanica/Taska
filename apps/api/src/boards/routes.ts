import type { ServerResponse } from "node:http";
import type { FastifyPluginAsync } from "fastify";
import { BOARD_SORTS, CARD_DENSITIES, DETAIL_LEVELS } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { problemResponses } from "../errors.js";
import { requireAuth } from "../auth/sessions.js";
import { changeBus } from "../events.js";
import { boardService } from "./service.js";

const loose = { type: "object", additionalProperties: true } as const;
const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", maxLength: 64 } },
} as const;
/** Дорожки и чипы: системные разрезы или «field:<ключ>» любого измерения (R-2.14). */
const LANE_PATTERN = "^(none|parent|team|stream|assignee|tags|field:[a-z][a-z0-9_]{1,39})$";
const CHIP_PATTERN = "^(type|stream|team|assignee|tags|field:[a-z][a-z0-9_]{1,39})$";
const filterList = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "query"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 64 },
      name: { type: "string", maxLength: 120 },
      query: { type: "string", maxLength: 4000 },
    },
  },
} as const;
const options = {
  lanes: { type: "string", pattern: LANE_PATTERN },
  sort: { type: "string", enum: BOARD_SORTS },
  doneDays: { type: "integer", minimum: 0, maximum: 3650 },
  chips: { type: "array", maxItems: 10, items: { type: "string", pattern: CHIP_PATTERN } },
  tqlLanes: filterList,
  tqlChips: filterList,
} as const;

/** Доски (R-2.18, R-2.19; docs/adr/0022) и поток живых изменений. */
export const boardRoutes: FastifyPluginAsync<{ db: Database; keyPrefix: string }> = async (app, { db, keyPrefix }) => {
  const service = boardService(db, keyPrefix);
  const tags = ["boards"];
  // Открытые потоки закрываем сами, иначе остановка сервера ждёт их вечно.
  const streams = new Set<ServerResponse>();
  app.addHook("onClose", async () => {
    for (const stream of streams) stream.end();
  });

  app.get(
    "/api/v1/boards",
    {
      schema: {
        tags,
        summary: "Boards the viewer can open: personal (with the starting «My tasks») and boards of visible spaces",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: loose } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: service.list(requireAuth(request).user) }),
  );

  app.post(
    "/api/v1/boards",
    {
      schema: {
        tags,
        summary: "New board: a TQL filter, an owner (space or the viewer) and a layout",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "query", "spaceId"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            query: { type: "string", maxLength: 4000 },
            spaceId: { type: ["string", "null"], maxLength: 64 },
            ...options,
          },
        },
        response: { 201: loose, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { user } = requireAuth(request);
      return reply.code(201).send(service.create(user, request.body as never));
    },
  );

  app.get(
    "/api/v1/boards/:id",
    {
      schema: {
        tags,
        summary:
          "Board with its cards: the filter's tickets the viewer may see, without old finished ones; personal settings. " +
          "`q` refines the filter (the link keeps it); lane and chip filters come with the ids they match",
        params: idParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { q: { type: "string", maxLength: 4000 } },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      service.view(
        requireAuth(request).user,
        (request.params as { id: string }).id,
        (request.query as { q?: string }).q,
      ),
  );

  app.patch(
    "/api/v1/boards/:id",
    {
      schema: {
        tags,
        summary: "Change the filter or layout (space board: «Configure space boards» right; personal: owner)",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1, maxLength: 200 }, query: { type: "string" }, ...options },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      service.update(requireAuth(request).user, (request.params as { id: string }).id, request.body as never),
  );

  app.delete(
    "/api/v1/boards/:id",
    { schema: { tags, summary: "Delete a board (tickets stay)", params: idParams } },
    async (request, reply) => {
      service.remove(requireAuth(request).user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );

  app.put(
    "/api/v1/boards/:id/zones",
    {
      schema: {
        tags,
        summary: "Rebuild the zone tree of the board: any depth; each status in one zone; a WIP limit on any zone",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["zones"],
          properties: {
            zones: {
              type: "array",
              maxItems: 200,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "name", "parentId", "statuses"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 64 },
                  name: { type: "string", maxLength: 120 },
                  parentId: { type: ["string", "null"], maxLength: 64 },
                  statuses: { type: "array", maxItems: 100, items: { type: "string", maxLength: 120 } },
                  wipLimit: { type: ["integer", "null"], minimum: 1 },
                },
              },
            },
          },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      service.setZones(
        requireAuth(request).user,
        (request.params as { id: string }).id,
        (request.body as { zones: never }).zones,
      ),
  );

  app.put(
    "/api/v1/boards/:id/prefs",
    {
      schema: {
        tags,
        summary: "Personal settings of the board: detail level, collapsed zones and levels, density, chips, lanes",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["detail", "collapsed", "hiddenLevels", "density", "chipsOff", "lanes", "lanesCollapsed"],
          properties: {
            detail: { type: "integer", enum: DETAIL_LEVELS },
            collapsed: { type: "array", maxItems: 200, items: { type: "string", maxLength: 64 } },
            hiddenLevels: { type: "array", maxItems: 10, items: { type: "integer", minimum: 1, maximum: 10 } },
            density: { type: "string", enum: CARD_DENSITIES },
            chipsOff: { type: "array", maxItems: 500, items: { type: "string", maxLength: 200 } },
            lanes: { anyOf: [{ type: "null" }, { type: "string", pattern: LANE_PATTERN }] },
            lanesCollapsed: { type: "array", maxItems: 500, items: { type: "string", maxLength: 200 } },
            tqlOn: { type: "array", maxItems: 50, items: { type: "string", maxLength: 64 } },
          },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      service.setPrefs(requireAuth(request).user, (request.params as { id: string }).id, request.body as never),
  );

  app.post(
    "/api/v1/boards/:id/move",
    {
      schema: {
        tags,
        summary:
          "Drop a card into a zone. No status of the card's type in the zone — 422 zone_not_for_type with the reason; " +
          "several — 409 status_choice_required with `candidates`, repeat with statusId. `order` keeps the manual order.",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["key", "version", "zoneId"],
          properties: {
            key: { type: "string", maxLength: 64 },
            version: { type: "integer" },
            zoneId: { type: "string", maxLength: 64 },
            statusId: { type: "string", maxLength: 64 },
            outcome: { type: "string", maxLength: 64 },
            order: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 64 } },
          },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      service.move(requireAuth(request).user, (request.params as { id: string }).id, request.body as never),
  );

  app.post(
    "/api/v1/boards/:id/order",
    {
      schema: {
        tags,
        summary: "Manual order of cards in a column (the board's sort must be «manual»)",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["order"],
          properties: { order: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 64 } } },
        },
      },
    },
    async (request, reply) => {
      service.reorder(
        requireAuth(request).user,
        (request.params as { id: string }).id,
        (request.body as { order: string[] }).order,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/boards/:id/tickets",
    {
      schema: {
        tags,
        summary: "Create a ticket from the board: team, stream and «assignee = me()» are taken from the filter",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["typeId", "title"],
          properties: {
            typeId: { type: "string", maxLength: 64 },
            title: { type: "string", minLength: 1, maxLength: 500 },
            spaceId: { type: "string", maxLength: 64 },
          },
        },
        response: { 201: loose, ...problemResponses },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          service.createTicket(requireAuth(request).user, (request.params as { id: string }).id, request.body as never),
        ),
  );

  /**
   * Живые изменения (R-2.18, R-3.3): Server-Sent Events. В событии нет данных — только «тикеты поменялись»;
   * клиент перечитывает доску через API, где права проверяются как обычно.
   */
  app.get(
    "/api/v1/events",
    { schema: { tags, summary: "Server-Sent Events: «tickets» when any ticket changed; re-read what you show" } },
    async (request, reply) => {
      const auth = requireAuth(request);
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      raw.write("retry: 3000\n\n");
      const bus = changeBus(db);
      const onChange = () => raw.write("event: tickets\ndata: {}\n\n");
      // Колокольчик: сигнал только своему получателю, тоже без содержимого (R-2.27).
      const onNotify = (event: { userId: string }) => {
        if (event.userId === auth.realUser.id) raw.write("event: notifications\ndata: {}\n\n");
      };
      bus.on("notifications", onNotify);
      const ping = setInterval(() => raw.write(": ping\n\n"), 25_000);
      bus.on("tickets", onChange);
      streams.add(raw);
      const stop = () => {
        streams.delete(raw);
        clearInterval(ping);
        bus.off("tickets", onChange);
        bus.off("notifications", onNotify);
      };
      request.raw.on("close", stop);
      raw.on("close", stop);
    },
  );
};
