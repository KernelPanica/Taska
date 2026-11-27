import type { FastifyPluginAsync } from "fastify";
import { NOTIFICATION_KINDS, type NotificationSetting } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin } from "../auth/sessions.js";
import { notifier, type TestChannel } from "./service.js";

const loose = { type: "object", additionalProperties: true } as const;
const settingsSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "enabled"],
        properties: { kind: { type: "string", enum: NOTIFICATION_KINDS }, enabled: { type: "boolean" } },
      },
    },
  },
} as const;

/** Колокольчик и настройки видов в профиле (R-2.27; docs/adr/0024). Пакет на запрос — хуки в app.ts. */
export const notificationRoutes: FastifyPluginAsync<{
  db: Database;
  testChannel: TestChannel | null;
  retryMs: number;
}> = async (app, { db, testChannel, retryMs }) => {
  const service = notifier(db);
  const tags = ["notifications"];

  // Канал, который не ответил, получит сообщение позже.
  const timer = setInterval(() => service.dispatch(), retryMs);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  app.get(
    "/api/v1/notifications",
    {
      schema: {
        tags,
        summary:
          "The bell, newest first. Tickets the reader cannot see come without key and title; " +
          "in show mode what the role cannot see is not shown at all",
        response: {
          200: {
            type: "object",
            required: ["items", "unread"],
            properties: { unread: { type: "integer" }, items: { type: "array", items: loose } },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const items = service.list(auth.realUser.id, auth.user);
      return { items, unread: items.filter((item) => !item.read).length };
    },
  );

  app.post(
    "/api/v1/notifications/read",
    {
      schema: {
        tags,
        summary: "Mark notifications as read (all when ids are omitted)",
        body: {
          type: "object",
          additionalProperties: false,
          properties: { ids: { type: "array", maxItems: 200, items: { type: "string", maxLength: 64 } } },
        },
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      service.markRead(requireAuth(request).realUser.id, (request.body as { ids?: string[] } | undefined)?.ids);
      return reply.status(204).send();
    },
  );

  app.get(
    "/api/v1/me/notification-settings",
    {
      schema: {
        tags,
        summary: "Which kinds of events reach me (everything is on by default)",
        response: { 200: settingsSchema, ...problemResponses },
      },
    },
    async (request) => ({ items: service.settings(requireAuth(request).realUser.id) }),
  );

  app.put(
    "/api/v1/me/notification-settings",
    {
      schema: {
        tags,
        summary: "Switch kinds of events on or off in my profile",
        body: settingsSchema,
        response: { 200: settingsSchema, ...problemResponses },
      },
    },
    async (request) => ({
      items: service.saveSettings(
        requireAuth(request).realUser.id,
        (request.body as { items: NotificationSetting[] }).items,
      ),
    }),
  );

  // Демо и разработка: что получил тестовый адаптер очереди (те же сообщения, что колокольчик).
  if (testChannel) {
    // Сообщения всех получателей — только суперадмину и только вне production (канал есть лишь там).
    app.get("/api/v1/notifications/test-outbox", { schema: { hide: true } }, async (request) => {
      requireSuperadmin(request);
      return { items: testChannel.received.slice(-100).reverse() };
    });
  }
};
