import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AppNotification,
  FeatureTeam,
  NotificationSetting,
  Person,
  Space,
  StatusScheme,
  Ticket,
  TicketType,
} from "@yourtask/contracts";
import { notifier } from "../src/notifications/service.js";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-18: уведомления и очередь событий (R-2.27, R-2.20). */
let app: FastifyInstance;
let admin: Client;
let anna: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
  anna = (await signIn(app, { login: "anna" })).user;
});

type Body<T> = T & { code?: string };
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => {
  const response = await user.request("GET", url);
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
};
const bell = async (user: Client) =>
  (await get<{ items: AppNotification[]; unread: number }>(user, "/api/v1/notifications")).body;

async function world() {
  const people = (await get<{ items: Person[] }>(admin, "/api/v1/people")).body.items;
  const person = (login: string) => people.find((item) => item.catalog?.username === login) as Person;
  const frogs = (
    await send<FeatureTeam>(admin, "POST", "/api/v1/feature-teams", {
      name: "Жабы",
      key: "Frogs",
      pmId: person("ben").id,
      memberIds: [person("anna").id],
    })
  ).body;
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).body.items;
  const type = (key: string) => (types.find((item) => item.key === key) as TicketType).id;
  const spaces = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).body.items;
  const space = (slug: string) => (spaces.find((item) => item.slug === slug) as Space).id;
  const create = async (title: string, extra: Record<string, unknown> = {}, spaceSlug = "production") => {
    const created = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: space(spaceSlug),
      typeId: type("task"),
      title,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (!Object.keys(extra).length) return created.body;
    const patched = await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${created.body.key}`, {
      version: created.body.version,
      ...extra,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return patched.body;
  };
  const statusId = async (ticket: Ticket, name: string) =>
    (await get<StatusScheme>(admin, `/api/v1/ticket-types/${ticket.typeId}/scheme`)).body.statuses.find(
      (status) => status.name === name,
    )?.id as string;
  const transition = async (ticket: Ticket, name: string) => {
    const current = (await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).body;
    const moved = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
      version: current.version,
      statusId: await statusId(ticket, name),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    return moved.body;
  };
  return { person, frogs, create, transition };
}

describe("events of R-2.27 reach the bell", () => {
  test("a watcher gets the status change and the new comment; repeats on one ticket update one live record", async () => {
    const { person, frogs, create, transition } = await world();
    const ticket = await create("Скрипт смены камеры", {
      values: { team: frogs.id },
      people: { watcherIds: [person("anna").id] },
    });
    await transition(ticket, "To Do");
    let items = (await bell(anna)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "status_changed",
      actor: { name: "Суперадмин Тестовый" },
      tickets: [{ key: ticket.key, title: "Скрипт смены камеры", available: true }],
      entries: [{ from: "Backlog", to: "To Do" }],
      read: false,
      live: true,
    });
    // Ещё одна смена того же тикета, пока не прочитано: та же запись обновилась на месте.
    await transition(ticket, "Creation");
    items = (await bell(anna)).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.entries.map((entry) => entry.to)).toEqual(["To Do", "Creation"]);

    const comment = await send(admin, "POST", `/api/v1/tickets/${ticket.key}/comments`, {
      body: "Камера **дёргается** при смене героя",
    });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    const after = await bell(anna);
    expect(after.unread).toBe(2);
    expect(after.items.find((item) => item.kind === "commented")?.entries[0]).toMatchObject({
      excerpt: "Камера дёргается при смене героя",
    });
    // Автору о своих действиях не сообщают.
    expect((await bell(admin)).items).toEqual([]);
  });

  test("the person mentioned in a comment gets a notification with a link; not twice as a watcher", async () => {
    const { person, frogs, create } = await world();
    const ticket = await create("Баланс урона партии", {
      values: { team: frogs.id },
      people: { watcherIds: [person("anna").id] },
    });
    await send(admin, "POST", `/api/v1/tickets/${ticket.key}/comments`, { body: "@anna посмотри баланс" });
    const items = (await bell(anna)).items;
    expect(items.map((item) => item.kind)).toEqual(["mentioned"]);
    expect(items[0]?.tickets[0]).toMatchObject({ key: ticket.key, available: true });
    expect(items[0]?.entries[0]?.commentId).toBeTruthy();
  });

  test("an assignment reaches only the people who were added", async () => {
    const { person, create } = await world();
    const ticket = await create("Иконки состояний", { people: { assigneeIds: [person("ben").id] } });
    const current = (await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).body;
    await send(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: current.version,
      people: { assigneeIds: [person("ben").id, person("anna").id] },
    });
    expect((await bell(anna)).items.map((item) => item.kind)).toEqual(["assigned"]);
  });
});

describe("grouping, settings, queue", () => {
  test("a bulk edit of 30 tickets gives one notification per recipient and kind", async () => {
    const { person, frogs, create } = await world();
    const keys: string[] = [];
    for (let index = 1; index <= 30; index += 1) {
      keys.push(
        (await create(`Задача ${index}`, { values: { team: frogs.id }, people: { watcherIds: [person("anna").id] } }))
          .key,
      );
    }
    const bulk = await send<{ items: Ticket[] }>(admin, "POST", "/api/v1/tickets/bulk", {
      keys,
      status: "To Do",
      assigneeIds: [person("anna").id],
    });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    expect(bulk.body.items).toHaveLength(30);
    const items = (await bell(anna)).items;
    expect(items.map((item) => item.kind).sort()).toEqual(["assigned", "status_changed"]);
    for (const item of items) {
      expect(item.batch).toBe(true);
      expect(item.tickets).toHaveLength(30);
    }
    // Тестовый адаптер очереди получил ровно те же сообщения, что колокольчик.
    const queued = (app.notificationsTest?.received ?? []).filter((message) => message.userId === person("anna").id);
    expect(queued.map((message) => message.kind).sort()).toEqual(["assigned", "status_changed"]);
    expect(queued.every((message) => message.entries.length === 30 && message.batch)).toBe(true);
    // Повтор того же запроса ничего не меняет и никому не пишет.
    await send(admin, "POST", "/api/v1/tickets/bulk", { keys, status: "To Do", assigneeIds: [person("anna").id] });
    expect((await bell(anna)).items).toHaveLength(2);
  });

  test("a bulk edit is all or nothing: one blocked ticket rolls back the rest and nobody is notified", async () => {
    const { person, create } = await world();
    const ok = await create("Можно", { people: { watcherIds: [person("anna").id] } });
    const failing = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: ok.spaceId,
      typeId: "type-story",
      title: "Стори без срока",
    });
    const refused = await send(admin, "POST", "/api/v1/tickets/bulk", {
      keys: [ok.key, failing.body.key],
      status: "Creation",
    });
    expect(refused.status).toBe(422);
    expect((await get<Ticket>(admin, `/api/v1/tickets/${ok.key}`)).body.statusId).toBe(ok.statusId);
    expect((await bell(anna)).items).toEqual([]);
  });

  test("a kind switched off in the profile does not come — neither to the bell nor to the queue", async () => {
    const { person, frogs, create, transition } = await world();
    const settings = await send<{ items: NotificationSetting[] }>(anna, "PUT", "/api/v1/me/notification-settings", {
      items: [{ kind: "status_changed", enabled: false }],
    });
    expect(settings.status).toBe(200);
    expect(settings.body.items.find((item) => item.kind === "status_changed")?.enabled).toBe(false);
    expect(settings.body.items.find((item) => item.kind === "commented")?.enabled).toBe(true);
    const ticket = await create("Звук смены героя", {
      values: { team: frogs.id },
      people: { watcherIds: [person("anna").id] },
    });
    await transition(ticket, "To Do");
    await send(admin, "POST", `/api/v1/tickets/${ticket.key}/comments`, { body: "Готово к проверке" });
    expect((await bell(anna)).items.map((item) => item.kind)).toEqual(["commented"]);
    expect(
      (app.notificationsTest?.received ?? [])
        .filter((message) => message.userId === person("anna").id)
        .map((message) => message.kind),
    ).toEqual(["commented"]);
  });
});

describe("rights", () => {
  test("in show mode a notification about a «Direction» ticket is not shown in the bell", async () => {
    const { create, person } = await world();
    const secret = await create("Бюджет студии", {}, "direction");
    const open = await create("Открытая задача", {}, "production");
    const adminId = (await get<{ user: { id: string } }>(admin, "/api/v1/me")).body.user.id;
    void person;
    // Событие системы (без автора): админ наблюдает оба тикета.
    notifier(app.db).publish({
      kind: "status_changed",
      actorId: null,
      recipients: [adminId],
      entries: [{ ticketId: secret.id, from: "Backlog", to: "To Do" }],
    });
    notifier(app.db).publish({
      kind: "status_changed",
      actorId: null,
      recipients: [adminId],
      entries: [{ ticketId: open.id, from: "Backlog", to: "To Do" }],
    });
    expect((await bell(admin)).items.map((item) => item.tickets[0]?.title).sort()).toEqual([
      "Бюджет студии",
      "Открытая задача",
    ]);
    await send(admin, "PUT", "/api/v1/me/lens", { kind: "profile", id: "profile-member", show: true });
    const shown = await bell(admin);
    expect(shown.items.map((item) => item.tickets[0]?.title)).toEqual(["Открытая задача"]);
    expect(shown.unread).toBe(1);
    expect(JSON.stringify(shown)).not.toContain("Бюджет");
  });

  test("a ticket hidden from the reader later is shown without key, title or content", async () => {
    const { person, frogs, create, transition } = await world();
    const ticket = await create("Тайный тикет", {
      values: { team: frogs.id },
      people: { watcherIds: [person("anna").id] },
    });
    await transition(ticket, "To Do");
    const current = (await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).body;
    const hidden = await send(admin, "PUT", `/api/v1/tickets/${ticket.key}/visibility`, {
      version: current.version,
      visibility: "hidden",
      allow: [],
    });
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    const item = (await bell(anna)).items[0];
    expect(item?.tickets[0]).toEqual({ id: ticket.id, key: null, title: null, available: false });
    expect(item?.entries[0]).toMatchObject({ from: null, to: null, excerpt: null });
    // И пока скрыт — новые события о нём не приходят.
    await transition(ticket, "Creation");
    expect((await bell(anna)).items).toHaveLength(1);
  });
});
