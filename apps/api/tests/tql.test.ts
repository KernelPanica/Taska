import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  FeatureTeam,
  Guild,
  LinkType,
  Person,
  SavedFilter,
  SearchResult,
  Space,
  StatusScheme,
  Ticket,
  TicketSummary,
  TicketType,
  TqlProblem,
} from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-15: TQL, полнотекст и сохранённые фильтры через API (R-2.28, R-5.3, R-2.20). */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

type Body<T> = T & { code?: string; tql?: TqlProblem; detail?: string };
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => {
  const response = await user.request("GET", url);
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
};
type Found = SearchResult<TicketSummary & { spaceId: string }>;
const search = (user: Client, q: string, extra = "") =>
  get<Found>(user, `/api/v1/search?q=${encodeURIComponent(q)}${extra}`);
const keysOf = (result: { body: Found }) => result.body.items.map((item) => item.title).sort();

/** Жабы (Frogs, ПМ — Бен), Хрюшки (Pigs), колодец ГД (GD, лид — Бен); Анна — в Жабах. */
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
  const pigs = (await send<FeatureTeam>(admin, "POST", "/api/v1/feature-teams", { name: "Хрюшки", key: "Pigs" })).body;
  const gd = (
    await send<Guild>(admin, "POST", "/api/v1/guilds", {
      name: "ГД",
      key: "GD",
      leadId: person("ben").id,
      memberIds: [person("ben").id],
    })
  ).body;
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).body.items;
  const type = (key: string) => (types.find((item) => item.key === key) as TicketType).id;
  const spaces = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).body.items;
  const production = (spaces.find((item) => item.slug === "production") as Space).id;
  const create = async (title: string, kind = "story", extra: Record<string, unknown> = {}) => {
    const created = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: production,
      typeId: type(kind),
      title,
      ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
  };
  const patch = async (ticket: Ticket, body: Record<string, unknown>) => {
    const current = (await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).body;
    const patched = await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: current.version,
      ...body,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return patched.body;
  };
  /** Статус по имени — прямо в базе: здесь проверяется поиск, а не условия входа (YT-05). */
  const status = async (ticket: Ticket, name: string) => {
    const scheme = (
      await get<StatusScheme>(admin, `/api/v1/ticket-types/${ticket.typeId}/scheme?spaceId=${ticket.spaceId}`)
    ).body;
    const target = scheme.statuses.find((item) => item.name === name);
    expect(target, name).toBeTruthy();
    app.db.prepare("UPDATE tickets SET status_id = ? WHERE key = ?").run(target?.id, ticket.key);
  };
  return { person, frogs, pigs, gd, production, create, patch, status, type };
}

describe("TQL examples of R-5.3 return the expected tickets", () => {
  test("team boards, the GD lead board, mine in work, overdue, branch in a zone, bugs after a feature, urgent, old number", async () => {
    const { person, frogs, pigs, gd, create, patch, status } = await world();
    const anna = (await signIn(app, { login: "anna" })).user;

    // Доска Жаб: своя команда и общая задача, где Жабы — у ребёнка.
    const own = await create("Свой тикет Жаб");
    await patch(own, { values: { team: frogs.id } });
    const shared = await create("Общий билд", "epic");
    const part = await create("Часть Жаб", "task", { parentKey: shared.key });
    await patch(part, { values: { team: frogs.id } });
    const foreign = await create("Тикет Хрюшек");
    await patch(foreign, { values: { team: pigs.id } });
    expect(keysOf(await search(admin, "team = Frogs or involvedTeams = Frogs"))).toEqual(
      ["Общий билд", "Свой тикет Жаб", "Часть Жаб"].sort(),
    );
    // Отображаемое имя — в кавычках; результат тот же.
    expect(keysOf(await search(admin, 'team = "Жабы"'))).toEqual(["Свой тикет Жаб", "Часть Жаб"].sort());

    // Доска лида ГД: стрим ГД или исполнитель из колодца ГД.
    const streamed = await create("Стрим ГД");
    await patch(streamed, { values: { stream: [gd.id] } });
    const byLead = await create("Исполнитель из ГД");
    await patch(byLead, { people: { assigneeIds: [person("ben").id] } });
    expect(keysOf(await search(admin, "stream = GD or assignee.guild = GD"))).toEqual(
      ["Исполнитель из ГД", "Стрим ГД"].sort(),
    );

    // Мои в работе: глазами Анны.
    const mine = await create("Моё в работе");
    await patch(mine, { people: { assigneeIds: [person("anna").id] } });
    await status(mine, "Creation");
    const mineQueued = await create("Моё в очереди");
    await patch(mineQueued, { people: { assigneeIds: [person("anna").id] } });
    expect(keysOf(await search(anna, "assignee = me() and statusCategory = active"))).toEqual(["Моё в работе"]);

    // Просроченные: срок вчера и не завершён.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const late = await create("Просрочен");
    await patch(late, { endDate: yesterday });
    const lateDone = await create("Просрочен, но готов");
    await patch(lateDone, { endDate: yesterday });
    await status(lateDone, "Done");
    expect(keysOf(await search(admin, "due < today() and statusCategory != done"))).toEqual(["Просрочен"]);

    // Ветка эпика в зоне Delivery (стартовое дерево зон R-5.1).
    const epic = await create("Боевая система", "epic");
    const inDelivery = await create("В Delivery", "story", { parentKey: epic.key });
    await status(inDelivery, "To Do");
    const grandchild = await create("Внук в тесте", "task", { parentKey: inDelivery.key });
    await status(grandchild, "Creation");
    await create("В бэклоге", "story", { parentKey: epic.key });
    expect(keysOf(await search(admin, `branch(${epic.key}) and zone = Delivery`))).toEqual(
      ["В Delivery", "Внук в тесте"].sort(),
    );

    // Баги после фичи: связь «вызывает».
    const feature = await create("Переключение персонажа");
    const bug = await create("Камера дёргается", "bug");
    const otherBug = await create("Чужой баг", "bug");
    const links = (await get<{ items: LinkType[] }>(admin, "/api/v1/link-types")).body.items;
    const causes = (links.find((item) => item.key === "causes") as LinkType).id;
    await send(admin, "POST", `/api/v1/tickets/${feature.key}/links`, { typeId: causes, targetKey: bug.key });
    expect(keysOf(await search(admin, `type = Bug and causedBy(${feature.key})`))).toEqual(["Камера дёргается"]);
    expect(otherBug.title).toBe("Чужой баг");

    // Срочная дорожка: «Urgent» — синоним высшего приоритета.
    const urgent = await create("Горит");
    await patch(urgent, { priority: "highest" });
    expect(keysOf(await search(admin, "priority = Urgent"))).toEqual(["Горит"]);

    // Старый номер Taiga — только чтение, заполняет импорт (YT-29).
    const imported = await create("Из Тайги");
    app.db.prepare("UPDATE tickets SET legacy_number = ? WHERE key = ?").run("General #57", imported.key);
    expect(keysOf(await search(admin, 'legacyNumber = "General #57"'))).toEqual(["Из Тайги"]);
    expect((await get<Ticket>(admin, `/api/v1/tickets/${imported.key}`)).body.legacyNumber).toBe("General #57");
  });

  test("sorting, «not», «in», «is empty», dates and the canonical text in the answer", async () => {
    const { create, patch } = await world();
    const a = await create("Альфа");
    await patch(a, { priority: "high", endDate: "2026-12-01" });
    const b = await create("Бета");
    await patch(b, { priority: "low" });
    await create("Гамма");
    const result = await search(admin, "PRIORITY in (High, Low) ORDER BY priority DESC");
    expect(result.body.items.map((item) => item.title)).toEqual(["Альфа", "Бета"]);
    expect(result.body.query).toBe("priority in (High, Low) order by priority desc");
    expect(keysOf(await search(admin, "due is empty and not priority = normal"))).toEqual(["Бета"]);
    expect(keysOf(await search(admin, "due >= 2026-11-30 and created >= daysAgo(1)"))).toEqual(["Альфа"]);
  });
});

describe("full text (R-2.28)", () => {
  test("words find tickets by key, title, description, comments and old number; «ё» and case do not matter", async () => {
    const { create, patch } = await world();
    const camera = await create("Камера ДЁРГАЕТСЯ");
    const described = await create("Без слова в названии");
    await patch(described, { description: "Тряска камеры при смене героя" });
    const commented = await create("Обсуждение");
    await send(admin, "POST", `/api/v1/tickets/${commented.key}/comments`, { body: "Похоже, камера виновата" });
    const imported = await create("Импорт");
    app.db.prepare("UPDATE tickets SET legacy_number = ? WHERE key = ?").run("General #57", imported.key);

    expect(keysOf(await search(admin, "камер"))).toEqual(
      ["Без слова в названии", "Камера ДЁРГАЕТСЯ", "Обсуждение"].sort(),
    );
    expect(keysOf(await search(admin, "дергается"))).toEqual(["Камера ДЁРГАЕТСЯ"]);
    expect(keysOf(await search(admin, camera.key))).toEqual(["Камера ДЁРГАЕТСЯ"]);
    expect(keysOf(await search(admin, "#57"))).toEqual(["Импорт"]);
    expect(keysOf(await search(admin, 'text ~ "камер" and key != ' + camera.key))).toEqual(
      ["Без слова в названии", "Обсуждение"].sort(),
    );
    // Строка поиска списка пространства — тот же разборщик.
    const list = await get<{ items: TicketSummary[] }>(
      admin,
      `/api/v1/tickets?spaceId=${camera.spaceId}&q=${encodeURIComponent("камер")}`,
    );
    expect(list.body.items).toHaveLength(3);
  });

  test("an error in the query is 400 tql_invalid with the place and a hint", async () => {
    await world();
    const typo = await search(admin, "staus = Done");
    expect(typo.status).toBe(400);
    expect(typo.body).toMatchObject({
      code: "tql_invalid",
      tql: { code: "unknown_field", start: 0, end: 5, suggestion: "status" },
    });
    const value = await search(admin, "team = Toads");
    expect(value.body.tql).toMatchObject({ code: "unknown_value", found: "Toads" });
    const later = await search(admin, "overloaded()");
    expect(later.body.tql).toMatchObject({ code: "not_available", detail: "YT-19" });
  });
});

describe("rights and the show mode (R-2.20)", () => {
  test("hidden tickets are neither in the results nor in the count; «only title» is not searched by content", async () => {
    const { create, patch } = await world();
    const anna = (await signIn(app, { login: "anna" })).user;
    await create("Открытая камера");
    const hidden = await create("Секретная камера", "epic");
    const titleOnly = await create("Камера только заголовок");
    await send(admin, "PUT", `/api/v1/tickets/${hidden.key}/visibility`, {
      version: hidden.version,
      visibility: "hidden",
    });
    await patch(titleOnly, { description: "камера" });
    const fresh = (await get<Ticket>(admin, `/api/v1/tickets/${titleOnly.key}`)).body;
    await send(admin, "PUT", `/api/v1/tickets/${titleOnly.key}/visibility`, {
      version: fresh.version,
      visibility: "title_only",
    });
    expect((await search(admin, "камера")).body.total).toBe(3);
    const seen = await search(anna, "камера");
    expect(seen.body.total).toBe(1);
    expect(keysOf(seen)).toEqual(["Открытая камера"]);
  });

  test("in the show mode the search does not find tickets hidden from the chosen role", async () => {
    const { create } = await world();
    const hidden = await create("Секретный эпик", "epic");
    await create("Обычный эпик", "epic");
    await send(admin, "PUT", `/api/v1/tickets/${hidden.key}/visibility`, {
      version: hidden.version,
      visibility: "hidden",
    });
    expect((await search(admin, "type = Epic")).body.total).toBe(2);
    expect(
      (await send(admin, "PUT", "/api/v1/me/lens", { kind: "profile", id: "profile-member", show: true })).status,
    ).toBe(204);
    const shown = await search(admin, "type = Epic");
    expect(keysOf(shown)).toEqual(["Обычный эпик"]);
    expect(shown.body.total).toBe(1);
  });
});

describe("saved filters (R-2.28)", () => {
  test("a filter shared by the PM opens for a member; a member saves only personal ones", async () => {
    const { production, frogs, create, patch } = await world();
    const ben = (await signIn(app, { login: "ben" })).user;
    const anna = (await signIn(app, { login: "anna" })).user;
    const own = await create("Тикет Жаб");
    await patch(own, { values: { team: frogs.id } });

    const saved = await send<SavedFilter>(ben, "POST", "/api/v1/filters", {
      name: "Доска Жаб",
      query: "TEAM = Frogs  or involvedTeams = Frogs",
      shared: true,
      spaceId: production,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ query: "team = Frogs or involvedTeams = Frogs", shared: true, canEdit: true });

    const forAnna = (await get<{ items: SavedFilter[] }>(anna, `/api/v1/filters?spaceId=${production}`)).body.items;
    expect(forAnna).toMatchObject([
      { name: "Доска Жаб", shared: true, canEdit: false, owner: { name: expect.any(String) } },
    ]);
    expect(keysOf(await search(anna, (forAnna[0] as SavedFilter).query))).toEqual(["Тикет Жаб"]);

    const refused = await send(anna, "POST", "/api/v1/filters", {
      name: "Для всех",
      query: "type = Bug",
      shared: true,
      spaceId: production,
    });
    expect(refused.status).toBe(403);
    const personal = await send<SavedFilter>(anna, "POST", "/api/v1/filters", {
      name: "Мои",
      query: "assignee = me()",
    });
    expect(personal.status).toBe(201);
    expect((await get<{ items: SavedFilter[] }>(ben, "/api/v1/filters")).body.items.map((item) => item.name)).toEqual([
      "Доска Жаб",
    ]);
    expect((await send(anna, "DELETE", `/api/v1/filters/${saved.body.id}`)).status).toBe(404);
    expect((await send(anna, "POST", "/api/v1/filters", { name: "Сломан", query: "status = " })).body.code).toBe(
      "tql_invalid",
    );
  });
});
