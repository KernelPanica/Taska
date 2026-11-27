import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  HistoryEntry,
  Space,
  StatusPeriod,
  StatusScheme,
  Ticket,
  TicketComment,
  TicketType,
} from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-07: неизменяемый журнал и комментарии (R-2.25). */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

type Body<T> = T & { code?: string; errors?: { field: string }[] };
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => (await user.request("GET", url)).json() as T;

async function story(user = admin, spaceSlug = "core") {
  const types = (await get<{ items: TicketType[] }>(user, "/api/v1/ticket-types")).items;
  const spaces = (await get<{ items: Space[] }>(user, "/api/v1/spaces")).items;
  const typeId = types.find((type) => type.key === "story")?.id as string;
  const spaceId = spaces.find((space) => space.slug === spaceSlug)?.id as string;
  const ticket = (
    await send<Ticket>(user, "POST", "/api/v1/tickets", {
      spaceId,
      typeId,
      title: "Жаба",
      templateId: "template-story",
    })
  ).body;
  const scheme = await get<StatusScheme>(user, `/api/v1/ticket-types/${typeId}/scheme?spaceId=${spaceId}`);
  return { ticket, scheme };
}
const history = async (key: string, user = admin) =>
  (await get<{ items: HistoryEntry[] }>(user, `/api/v1/tickets/${key}/history`)).items;
const entry = (items: HistoryEntry[], field: string) => items.find((item) => item.field === field);

describe("change log", () => {
  test("every change of fields, status, people and dates is logged with author, time, from and to", async () => {
    const { ticket, scheme } = await story();
    const people = (await get<{ items: { id: string; name: string }[] }>(admin, "/api/v1/people")).items;
    const anna = people.find((person) => person.name === "Анна Тестова")?.id as string;
    const ben = people.find((person) => person.name === "Ben Tester")?.id as string;
    let current = (
      await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
        version: ticket.version,
        title: "Жаба прыгает",
        values: { size: "scale-tshirt-m", estimate_days: 6, due_date: "2026-12-20" },
        priority: "high",
        startDate: "2026-12-01",
        endDate: "2026-12-10",
        people: { assigneeIds: [anna, ben], testerId: ben },
      })
    ).body;
    const discovery = scheme.statuses.find((status) => status.name === "Discovery")?.id as string;
    current = (
      await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
        version: current.version,
        statusId: discovery,
      })
    ).body;

    const items = await history(ticket.key);
    expect(items.every((item) => item.actorName === "Суперадмин Тестовый" && item.source === "person" && item.at)).toBe(
      true,
    );
    expect(entry(items, "title")).toMatchObject({ from: { text: "Жаба" }, to: { text: "Жаба прыгает" } });
    expect(entry(items, "values.size")).toMatchObject({
      fieldLabel: "Размер",
      from: null,
      to: { raw: "scale-tshirt-m", text: "M" },
    });
    expect(entry(items, "values.estimate_days")).toMatchObject({ to: { raw: 6, text: "6 дн." } });
    expect(entry(items, "values.due_date")).toMatchObject({ to: { text: "2026-12-20" } });
    expect(entry(items, "priority")).toMatchObject({ from: { raw: "normal" }, to: { raw: "high" } });
    expect(entry(items, "startDate")).toMatchObject({ from: null, to: { text: "2026-12-01" } });
    expect(entry(items, "people.assignees")).toMatchObject({ from: null, to: { text: "Анна Тестова, Ben Tester" } });
    expect(entry(items, "people.tester")).toMatchObject({ to: { text: "Ben Tester" } });
    expect(entry(items, "status")).toMatchObject({ from: { text: "Backlog" }, to: { text: "Discovery" } });
    // Создание — тоже запись: по шаблону, со стартовым статусом.
    expect(items.at(-1)).toMatchObject({ field: "created", to: { text: "Жаба" } });
    expect(entry(items, "template")).toMatchObject({ to: { text: "Стори" } });

    // Убрали человека из тикета — история читается по-прежнему, профиль на месте.
    await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: current.version,
      people: { assigneeIds: [anna] },
    });
    const after = await history(ticket.key);
    expect(after[0]).toMatchObject({
      field: "people.assignees",
      from: { text: "Анна Тестова, Ben Tester" },
      to: { text: "Анна Тестова" },
    });
    expect(entry(after.slice(1), "people.assignees")).toMatchObject({ to: { text: "Анна Тестова, Ben Tester" } });
    expect((await admin.request("GET", `/api/v1/people/${ben}`)).statusCode).toBe(200);
  });

  test("the API cannot change or delete an entry, and neither can the database", async () => {
    const { ticket } = await story();
    const [first] = await history(ticket.key);
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      const response = await send(admin, method, `/api/v1/tickets/${ticket.key}/history/${first?.id}`, {
        to: "подделка",
      });
      expect(response.status, method).toBe(404);
      expect((await send(admin, method, `/api/v1/tickets/${ticket.key}/history`, {})).status, method).toBe(404);
    }
    const db = (
      app as unknown as {
        catalogSync: { options: { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } } };
      }
    ).catalogSync.options.db;
    expect(() => db.prepare("UPDATE ticket_history SET to_value = 'x' WHERE id = ?").run(first?.id)).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM ticket_history WHERE id = ?").run(first?.id)).toThrow(/append-only/);
    expect(await history(ticket.key)).toEqual(await history(ticket.key));
  });

  test("the status sequence with dates is exported as JSON and CSV", async () => {
    const { ticket, scheme } = await story();
    const id = (name: string) => scheme.statuses.find((status) => status.name === name)?.id as string;
    let current = (
      await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
        version: 1,
        values: { due_date: "2026-12-20" },
        people: { assigneeIds: [(await get<{ user: { id: string } }>(admin, "/api/v1/me")).user.id] },
      })
    ).body;
    current = (
      await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
        version: current.version,
        statusId: id("Discovery"),
      })
    ).body;
    await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/cancel`, {
      version: current.version,
      reason: "Не нужна",
    });

    const periods = (await get<{ items: StatusPeriod[] }>(admin, `/api/v1/tickets/${ticket.key}/status-history`)).items;
    expect(periods.map((period) => [period.name, period.category, period.outcome])).toEqual([
      ["Backlog", "queue", null],
      ["Discovery", "in_progress", null],
      ["Done", "done", "cancelled"],
    ]);
    expect(periods[0]?.leftAt).toBe(periods[1]?.enteredAt);
    expect(periods[2]?.leftAt).toBeNull();
    expect(Date.parse(periods[0]?.enteredAt ?? "")).toBeLessThanOrEqual(Date.parse(periods[2]?.enteredAt ?? ""));

    const csv = await admin.request("GET", `/api/v1/tickets/${ticket.key}/status-history?format=csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines[0]).toBe("key,status,category,outcome,entered_at,left_at,by");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain(`"${ticket.key}","Done","done","cancelled"`);
  });

  test("moving tickets after a status scheme change is logged as a system change", async () => {
    const { ticket, scheme } = await story();
    const renamed = scheme.statuses.map((status) =>
      status.name === "Backlog" ? { ...status, id: undefined, name: "Бэклог" } : status,
    );
    await send(admin, "PUT", `/api/v1/ticket-types/${ticket.typeId}/scheme`, {
      spaceId: null,
      strictOrder: false,
      statuses: renamed,
    });
    const [last] = await history(ticket.key);
    expect(last).toMatchObject({
      source: "system",
      sourceDetail: "status scheme changed",
      actorName: null,
      from: { text: "Backlog" },
    });
  });
});

describe("comments", () => {
  test("Markdown with mentions of a person and a ticket; links resolve for the viewer", async () => {
    const { ticket } = await story();
    const other = (await story()).ticket;
    const created = await send<TicketComment>(admin, "POST", `/api/v1/tickets/${ticket.key}/comments`, {
      body: `**Важно:** @anna посмотри ${other.key} и ${ticket.key}. Почта anna@yourspace.test — не упоминание. @nobody`,
    });
    expect(created.status).toBe(201);
    expect(created.body.mentions.people).toEqual([expect.objectContaining({ login: "anna", name: "Анна Тестова" })]);
    expect(created.body.mentions.tickets.map((item) => item.key).sort()).toEqual([other.key, ticket.key].sort());
    expect(created.body).toMatchObject({
      authorName: "Суперадмин Тестовый",
      canEdit: true,
      canDelete: true,
      editedAt: null,
    });

    // Обычный пользователь без доступа к пространству не видит ни тикет, ни его комментарии.
    const vera = (await signIn(app, { login: "vera" })).user;
    expect((await vera.request("GET", `/api/v1/tickets/${ticket.key}/comments`)).statusCode).toBe(404);
  });

  test("own comments are edited; deleting is by rights; the thread keeps a placeholder", async () => {
    const { ticket } = await story(admin, "test");
    const anna = (await signIn(app, { login: "anna" })).user;
    const mine = (
      await send<TicketComment>(anna, "POST", `/api/v1/tickets/${ticket.key}/comments`, { body: "Первый вариант" })
    ).body;
    const edited = await send<TicketComment>(anna, "PATCH", `/api/v1/comments/${mine.id}`, { body: "Исправлено @ben" });
    expect(edited.body).toMatchObject({ body: "Исправлено @ben", editedAt: expect.any(String) });
    expect(edited.body.mentions.people.map((person) => person.login)).toEqual(["ben"]);
    expect((await send(admin, "PATCH", `/api/v1/comments/${mine.id}`, { body: "Чужое" })).body.code).toBe("forbidden");
    const ben = (await signIn(app, { login: "ben" })).user;
    expect((await send(ben, "DELETE", `/api/v1/comments/${mine.id}`)).body.code).toBe("forbidden");
    const deleted = await send<TicketComment>(admin, "DELETE", `/api/v1/comments/${mine.id}`);
    expect(deleted.body).toMatchObject({ deleted: true, body: "", canEdit: false });
    const thread = (await get<{ items: TicketComment[] }>(anna, `/api/v1/tickets/${ticket.key}/comments`)).items;
    expect(thread).toEqual([expect.objectContaining({ id: mine.id, deleted: true, body: "" })]);
    expect((await send(anna, "POST", `/api/v1/tickets/${ticket.key}/comments`, { body: "   " })).body.code).toBe(
      "validation_failed",
    );
  });

  test("a task made from a comment links back and the comment shows its status", async () => {
    const { ticket } = await story();
    const comment = (
      await send<TicketComment>(admin, "POST", `/api/v1/tickets/${ticket.key}/comments`, { body: "Нужен звук прыжка" })
    ).body;
    const people = (await get<{ items: { id: string; name: string }[] }>(admin, "/api/v1/people")).items;
    const ben = people.find((person) => person.name === "Ben Tester")?.id as string;
    const made = await send<{ comment: TicketComment; ticketKey: string }>(
      admin,
      "POST",
      `/api/v1/comments/${comment.id}/make-ticket`,
      {
        title: "Звук прыжка",
        assigneeId: ben,
      },
    );
    expect(made.status).toBe(201);
    expect(made.body.comment.createdTicket).toMatchObject({
      key: made.body.ticketKey,
      title: "Звук прыжка",
      statusName: "Backlog",
    });
    const task = await get<Ticket>(admin, `/api/v1/tickets/${made.body.ticketKey}`);
    expect(task.description).toContain(`[${ticket.key}](/tickets/${ticket.key}#comment-${comment.id})`);
    expect(task.description).toContain("> Нужен звук прыжка");
    expect(task.people.assignees.map((person) => person.name)).toEqual(["Ben Tester"]);
    expect((await history(task.key)).at(-1)).toMatchObject({
      field: "created",
      sourceDetail: `from comment on ${ticket.key}`,
    });
    expect(entry(await history(ticket.key), "comment.ticket")).toMatchObject({ to: { raw: task.key } });

    // Статус задачи виден в комментарии и меняется вместе с ней.
    await send(admin, "POST", `/api/v1/tickets/${task.key}/cancel`, { version: task.version, reason: "Уже есть" });
    const thread = (await get<{ items: TicketComment[] }>(admin, `/api/v1/tickets/${ticket.key}/comments`)).items;
    expect(thread[0]?.createdTicket).toMatchObject({ statusName: "Done", category: "done" });
    expect((await send(admin, "POST", `/api/v1/comments/${comment.id}/make-ticket`, { title: "Ещё" })).body.code).toBe(
      "conflict",
    );
  });
});
