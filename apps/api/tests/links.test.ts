import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LinkType, Ticket, TicketType, WebLink } from "@yourtask/contracts";
import { fetchTitle, titleFromHtml } from "../src/integrations/link-preview.js";
import { SignInAgainError, YourWikiApi } from "../src/integrations/yourwiki.js";
import { SessionStore } from "../src/auth/sessions.js";
import { testConfig } from "../src/config.js";
import { orm } from "../src/db/index.js";
import { sessions } from "../src/db/schema.js";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-12: связи между тикетами и блок ссылок через API. */
let app: FastifyInstance;
let admin: Client;
let server: Server | null = null;
afterEach(async () => {
  await app?.close();
  server?.close();
  server = null;
});
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as T & { code?: string } };
}
const get = async <T>(user: Client, url: string) => (await user.request("GET", url)).json() as T;

async function kit() {
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).items;
  const type = (key: string) => (types.find((item) => item.key === key) as TicketType).id;
  const linkTypes = (await get<{ items: LinkType[] }>(admin, "/api/v1/link-types")).items;
  const link = (key: string) => (linkTypes.find((item) => item.key === key) as LinkType).id;
  const create = async (title: string, typeKey = "story", space = "space-production") =>
    (await send<Ticket>(admin, "POST", "/api/v1/tickets", { spaceId: space, typeId: type(typeKey), title })).body;
  const ticket = (key: string, user = admin) => get<Ticket>(user, `/api/v1/tickets/${key}`);
  return { type, link, create, ticket, linkTypes };
}

/** Правка документа в заглушке YourWiki — как «админ YourWiki» в его интерфейсе. */
async function wikiEdit(id: string, form: Record<string, string>) {
  const response = await app.inject({
    method: "POST",
    url: `/dev/yourwiki/documents/${id}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(form).toString(),
  });
  expect(response.statusCode).toBe(303);
}

const wikiUrl = (id: string) => `http://localhost:3000/dev/yourwiki/documents/${id}`;

describe("links between tickets (R-2.13)", () => {
  test("the link types of R-2.13 are there; an admin adds their own", async () => {
    const { linkTypes } = await kit();
    expect(linkTypes.map((item) => [item.key, item.name, item.inverseName])).toEqual([
      ["relates", "Связан с", "Связан с"],
      ["blocks", "Блокирует", "Заблокирован"],
      ["duplicates", "Дублирует", "Дублируется"],
      ["clones", "Клонирован из", "Клонирован в"],
      ["causes", "Вызывает", "Вызван"],
    ]);
    const own = await send<LinkType>(admin, "POST", "/api/v1/link-types", {
      name: "Зависит от",
      inverseName: "Нужен для",
    });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ name: "Зависит от", inverseName: "Нужен для", system: false });
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await send(anna, "POST", "/api/v1/link-types", { name: "Моё" })).status).toBe(403);
  });

  test("«blocks» is seen from both sides and becomes «relates to» in one action; removing the link keeps the tickets", async () => {
    const { link, create, ticket } = await kit();
    const story = await create("Переключение персонажа в бою");
    const combo = await create("Комбо при переключении героя");
    const linked = await send<Ticket>(admin, "POST", `/api/v1/tickets/${story.key}/links`, {
      typeId: link("blocks"),
      targetKey: combo.key,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.relations.links).toMatchObject([
      {
        label: "Блокирует",
        direction: "out",
        ticket: {
          available: true,
          key: combo.key,
          title: combo.title,
          statusName: "Backlog",
          spaceName: "Производство",
        },
      },
    ]);
    const other = await ticket(combo.key);
    expect(other.relations.links).toMatchObject([
      { label: "Заблокирован", direction: "in", ticket: { key: story.key } },
    ]);
    const id = other.relations.links[0]?.id as string;
    expect(
      (
        await send(admin, "POST", `/api/v1/tickets/${story.key}/links`, {
          typeId: link("blocks"),
          targetKey: combo.key,
        })
      ).body.code,
    ).toBe("link_exists");

    const changed = await send<Ticket>(admin, "PATCH", `/api/v1/links/${id}`, {
      typeId: link("relates"),
      fromKey: combo.key,
    });
    expect(changed.body.relations.links).toMatchObject([{ id, label: "Связан с", ticket: { key: story.key } }]);
    expect((await ticket(story.key)).relations.links).toMatchObject([{ id, label: "Связан с" }]);
    const history = (
      await get<{ items: { field: string; from: { text: string } | null; to: { text: string } | null }[] }>(
        admin,
        `/api/v1/tickets/${story.key}/history`,
      )
    ).items.filter((entry) => entry.field === "links");
    expect(history[0]).toMatchObject({
      from: { text: `Блокирует: ${combo.key} ${combo.title}` },
      to: { text: `Связан с: ${combo.key} ${combo.title}` },
    });

    const removed = await send<Ticket>(admin, "DELETE", `/api/v1/links/${id}?fromKey=${story.key}`);
    expect(removed.body.relations.links).toEqual([]);
    expect((await ticket(combo.key)).relations.links).toEqual([]);
    expect((await ticket(combo.key)).title).toBe(combo.title);
    expect((await ticket(story.key)).title).toBe(story.title);
  });

  test("a bug is linked to the story as «caused by» and does not become a child; it stays out of the progress", async () => {
    const { link, create, ticket } = await kit();
    const story = await create("Переключение персонажа в бою");
    const bug = await create("Камера дёргается при переключении", "bug");
    const linked = await send<Ticket>(admin, "POST", `/api/v1/tickets/${bug.key}/links`, {
      typeId: link("causes"),
      targetKey: story.key,
      direction: "in",
    });
    expect(linked.body.relations.links).toMatchObject([{ label: "Вызван", ticket: { key: story.key } }]);
    expect(linked.body.relations.parents).toEqual([]);
    const fromStory = await ticket(story.key);
    expect(fromStory.relations.links).toMatchObject([{ label: "Вызывает", ticket: { key: bug.key } }]);
    expect(fromStory.relations.children).toEqual([]);

    // Даже если баг всё же сделали ребёнком, прогресс стори его не считает.
    await send(admin, "POST", `/api/v1/tickets/${bug.key}/parents`, { parentKey: story.key });
    await send(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: (await kit()).type("task"),
      title: "Задача",
      parentKey: story.key,
    });
    expect((await ticket(story.key)).rollup.progress).toEqual({ done: 0, total: 1, percent: 0 });
  });

  test("a «relates to» link between Core and Direction is an «unavailable» row for a Core member", async () => {
    const { link, create } = await kit();
    const onboarding = await create("Онбординг Веры", "task", "space-core");
    const contract = await create("Договор с Верой", "task", "space-direction");
    await send(admin, "POST", `/api/v1/tickets/${onboarding.key}/links`, {
      typeId: link("relates"),
      targetKey: contract.key,
    });
    const ben = (await signIn(app, { login: "ben" })).user;
    const seen = await get<Ticket>(ben, `/api/v1/tickets/${onboarding.key}`);
    expect(seen.relations.links).toMatchObject([{ label: "Связан с", ticket: { available: false } }]);
    expect(JSON.stringify(seen)).not.toContain(contract.key);
    expect(JSON.stringify(seen)).not.toContain("Договор");
    const history = await get<object>(ben, `/api/v1/tickets/${onboarding.key}/history`);
    expect(JSON.stringify(history)).not.toContain("Договор");
    // Связать с недоступным нельзя: для зрителя его нет.
    expect(
      (
        await send(ben, "POST", `/api/v1/tickets/${onboarding.key}/links`, {
          typeId: link("relates"),
          targetKey: contract.key,
        })
      ).status,
    ).toBe(404);
  });
});

describe("links block and YourWiki documents (R-2.24, R-2.40)", () => {
  const items = async (user: Client, key: string) =>
    (await get<{ items: WebLink[] }>(user, `/api/v1/tickets/${key}/web-links`)).items;

  test("renaming the document in YourWiki changes the link title in the ticket", async () => {
    const { create } = await kit();
    const story = await create("Стори");
    const added = await send<{ items: WebLink[] }>(admin, "POST", `/api/v1/tickets/${story.key}/web-links`, {
      url: wikiUrl("gdd-combat"),
    });
    expect(added.status).toBe(200);
    expect(added.body.items).toMatchObject([
      {
        kind: "yourwiki",
        title: "ГДД: боевая система",
        document: { state: "available", access: "read", wikiUrl: wikiUrl("gdd-combat"), source: { type: "google" } },
      },
    ]);
    await wikiEdit("gdd-combat", { title: "ГДД: боевая система v2", state: "active", open: "on" });
    expect((await items(admin, story.key))[0]?.title).toBe("ГДД: боевая система v2");
  });

  test("«Open original» goes to the source service and only for those with access there; a trashed document shows «in trash»", async () => {
    const { create } = await kit();
    const story = await create("Стори");
    await send(admin, "POST", `/api/v1/tickets/${story.key}/web-links`, { url: wikiUrl("gdd-combat") });
    expect((await items(admin, story.key))[0]?.document?.originalUrl).toBe(
      "https://docs.google.com/document/d/gdd-combat-original/edit",
    );
    const ben = (await signIn(app, { login: "ben" })).user;
    // У Бена документ в YourWiki открыт, но доступ к оригиналу в Google не проверен — кнопки нет.
    expect((await items(ben, story.key))[0]?.document).toMatchObject({ access: "read", originalUrl: null });

    await wikiEdit("gdd-combat", { title: "ГДД: боевая система", state: "trashed", open: "on" });
    expect((await items(admin, story.key))[0]?.document).toMatchObject({ state: "trashed", originalUrl: null });
    await wikiEdit("gdd-combat", { title: "ГДД: боевая система", state: "deleted", open: "on" });
    expect((await items(admin, story.key))[0]).toMatchObject({
      title: null,
      document: { state: "deleted", originalUrl: null },
    });
  });

  test("a user without access sees «no access» without the title and asks for access; YourWiki gets the request", async () => {
    const { create } = await kit();
    const story = await create("Стори");
    await send(admin, "POST", `/api/v1/tickets/${story.key}/web-links`, { url: wikiUrl("tech-camera") });
    // Тикет открыт, документ — нет: суперадмину предупреждение о расхождении доступов.
    expect((await items(admin, story.key))[0]).toMatchObject({
      title: "ТехГДД: камера",
      warning: "ticket_open_document_restricted",
    });
    const anna = (await signIn(app, { login: "anna" })).user;
    const before = (await items(anna, story.key))[0] as WebLink;
    expect(before).toMatchObject({
      title: null,
      document: { state: "unavailable", access: "none", canRequestAccess: true, requested: false, wikiUrl: null },
    });
    expect(JSON.stringify(before)).not.toContain("ТехГДД");
    const asked = await send<{ items: WebLink[] }>(anna, "POST", `/api/v1/web-links/${before.id}/request-access`);
    expect(asked.body.items[0]?.document).toMatchObject({ requested: true });
    const page = await app.inject({ method: "GET", url: "/dev/yourwiki" });
    expect(page.body).toContain("ys-test-anna");
  });

  test("a link to an outside site shows the page title", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><head><title>Референс: переключение героя &amp; камера</title></head><body></body></html>");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const { create } = await kit();
    const story = await create("Стори");
    const added = await send<{ items: WebLink[] }>(admin, "POST", `/api/v1/tickets/${story.key}/web-links`, {
      url: `http://127.0.0.1:${port}/video`,
    });
    expect(added.body.items).toMatchObject([
      { kind: "web", title: "Референс: переключение героя & камера", document: null },
    ]);
    expect(
      (await send(admin, "POST", `/api/v1/tickets/${story.key}/web-links`, { url: "javascript:alert(1)" })).status,
    ).toBe(400);
  });

  test("link previews do not reach the internal network outside development (SSRF)", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Внутренний</title>");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    expect(await fetchTitle(`http://127.0.0.1:${port}/`, false)).toBeNull();
    expect(await fetchTitle(`http://127.0.0.1:${port}/`, true)).toBe("Внутренний");
    expect(await fetchTitle("file:///etc/passwd", true)).toBeNull();
    expect(titleFromHtml('<meta property="og:title" content="OG заголовок"><title>T</title>')).toBe("OG заголовок");
  });

  test("the WK-02 client calls YourWiki with the person's YourSpace token from the session", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const store = new SessionStore(orm(app.db), testConfig().secretKey, 168);
    const adminId = (
      app.db.prepare("SELECT id FROM users WHERE yourspace_subject = 'ys-test-admin'").get() as { id: string }
    ).id;
    const row = orm(app.db)
      .select()
      .from(sessions)
      .all()
      .find((item) => item.userId === adminId && item.yourspaceToken) as typeof sessions.$inferSelect;
    const token = store.yourspaceToken(row);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.yourspaceToken).not.toContain(token as string);

    const client = new YourWikiApi(`${address}/dev/yourwiki`);
    expect(client.owns(`${address}/dev/yourwiki/documents/gdd-combat`)).toBe(true);
    expect(client.owns("https://example.com/documents/gdd-combat")).toBe(false);
    const who = { token, subject: null };
    expect(await client.document("gdd-combat", who)).toMatchObject({
      id: "gdd-combat",
      title: "ГДД: боевая система",
      state: "available",
    });
    expect(await client.resolve(wikiUrl("tech-camera"), who)).toMatchObject({
      title: "ТехГДД: камера",
    });
    await client.requestAccess(wikiUrl("team-mechanics"), "", who);
    await expect(client.document("gdd-combat", { token: "x".repeat(43), subject: null })).rejects.toThrow(
      SignInAgainError,
    );
    await expect(client.document("gdd-combat", { token: null, subject: "ys-test-admin" })).rejects.toThrow(
      SignInAgainError,
    );
  });
});

describe("mentions in the description (R-2.24)", () => {
  test("the same person or ticket mentioned twice is resolved once, without an error", async () => {
    const { create } = await kit();
    const other = await create("Комбо");
    const story = await create("Стори");
    const current = await get<Ticket>(admin, `/api/v1/tickets/${story.key}`);
    await send(admin, "PATCH", `/api/v1/tickets/${story.key}`, {
      version: current.version,
      description: `См. ${other.key} и ещё раз ${other.key}. @ben, @ben — посмотри.`,
    });
    const response = await admin.request("GET", `/api/v1/tickets/${story.key}/mentions`);
    expect(response.statusCode).toBe(200);
    const mentions = response.json() as { people: { login: string }[]; tickets: { key: string }[] };
    expect(mentions.tickets.map((item) => item.key)).toEqual([other.key]);
    expect(mentions.people.map((item) => item.login)).toEqual(["ben"]);
  });
});
