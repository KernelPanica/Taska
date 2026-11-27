import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  boardLayout,
  type Board,
  type BoardSummary,
  type BoardView,
  type FeatureTeam,
  type Guild,
  type Person,
  type Space,
  type StatusScheme,
  type Ticket,
  type TicketType,
} from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-16: доски и зоны через API (R-2.18, R-2.19, R-5.1, R-3.3). */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

type Body<T> = T & {
  code?: string;
  detail?: string;
  candidates?: { id: string; name: string }[];
  zone?: string;
  ticketType?: string;
};
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => {
  const response = await user.request("GET", url);
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
};
const view = async (user: Client, id: string) => (await get<BoardView>(user, `/api/v1/boards/${id}`)).body;
const titles = (board: BoardView) => board.cards.map((card) => card.title).sort();

/** Жабы (ПМ — Бен, Анна — участник), Хрюшки, колодец ГД (лид — Бен). */
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
  const create = async (title: string, kind = "story", values: Record<string, unknown> = {}) => {
    const created = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: production,
      typeId: type(kind),
      title,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (!Object.keys(values).length) return created.body;
    return patch(created.body, values);
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
  const status = async (ticket: Ticket, name: string) => {
    const scheme = (
      await get<StatusScheme>(admin, `/api/v1/ticket-types/${ticket.typeId}/scheme?spaceId=${ticket.spaceId}`)
    ).body;
    const target = scheme.statuses.find((item) => item.name === name);
    expect(target, name).toBeTruthy();
    app.db
      .prepare("UPDATE tickets SET status_id = ?, status_changed_at = ? WHERE key = ?")
      .run(target?.id, Date.now(), ticket.key);
  };
  const board = async (user: Client, name: string, query: string, spaceId: string | null = production, extra = {}) => {
    const created = await send<Board>(user, "POST", "/api/v1/boards", { name, query, spaceId, ...extra });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
  };
  return { person, frogs, pigs, gd, production, type, create, patch, status, board };
}

const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe("boards are TQL filters", () => {
  test("the Frogs board and the GD lead board are one entity with different filters; the same ticket is on both", async () => {
    const { frogs, pigs, gd, create, board } = await world();
    const both = await create("Переключение персонажа в бою", "story", { values: { team: frogs.id, stream: [gd.id] } });
    await create("Комбо при переключении", "story", { values: { team: frogs.id } });
    await create("Лут сундуков", "task", { values: { team: pigs.id, stream: [gd.id] } });
    await create("Чужое", "story", { values: { team: pigs.id } });

    const frogsBoard = await board(admin, "Жабы", "team = Frogs or involvedTeams = Frogs", undefined, {
      lanes: "parent",
      chips: ["stream", "type"],
    });
    const gdBoard = await board(admin, "Лид ГД", "stream = GD or assignee.guild = GD", undefined, { lanes: "team" });

    const list = (await get<{ items: BoardSummary[] }>(admin, "/api/v1/boards")).body.items;
    expect(list.map((item) => item.name)).toEqual(expect.arrayContaining(["Мои задачи", "Жабы", "Лид ГД"]));
    expect(list.find((item) => item.id === gdBoard.id)?.owner).toMatchObject({
      kind: "space",
      spaceSlug: "production",
    });

    const frogsView = await view(admin, frogsBoard.id);
    const gdView = await view(admin, gdBoard.id);
    expect(titles(frogsView)).toEqual(["Комбо при переключении", "Переключение персонажа в бою"]);
    expect(titles(gdView)).toEqual(["Лут сундуков", "Переключение персонажа в бою"]);
    // Одна и та же карточка — один тикет, не копия.
    const a = frogsView.cards.find((card) => card.key === both.key);
    const b = gdView.cards.find((card) => card.key === both.key);
    expect(a?.id).toBe(b?.id);
    expect(a).toMatchObject({ team: { name: "Жабы" }, streams: [{ name: "ГД" }], statusName: "Backlog" });
    expect(frogsView.board).toMatchObject({ lanes: "parent", chips: ["stream", "type"], doneDays: 14 });
    expect(gdView.board.lanes).toBe("team");
  });

  test("a broken filter is not saved: 400 tql_invalid", async () => {
    const { board } = await world();
    void board;
    const broken = await send(admin, "POST", "/api/v1/boards", { name: "x", query: "team = ", spaceId: null });
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe("tql_invalid");
  });

  test("a new person has «My tasks»: own tickets in work and in the queue, finished ones are not there", async () => {
    const { person, create, status } = await world();
    const anna = (await signIn(app, { login: "anna" })).user;
    const working = await create("В работе", "story", { people: { assigneeIds: [person("anna").id] } });
    await status(working, "Creation");
    await create("В очереди", "story", { people: { assigneeIds: [person("anna").id] } });
    const done = await create("Готово", "task", { people: { assigneeIds: [person("anna").id] } });
    await status(done, "Done");
    await create("Чужая", "story", { people: { assigneeIds: [person("ben").id] } });

    const boards = (await get<{ items: BoardSummary[] }>(anna, "/api/v1/boards")).body.items;
    const mine = boards.find((item) => item.kind === "mine") as BoardSummary;
    expect(mine).toMatchObject({ name: "Мои задачи", owner: { kind: "person" }, canEdit: true });
    expect(mine.query).toBe("assignee = me() and statusCategory != done");
    expect(titles(await view(anna, mine.id))).toEqual(["В очереди", "В работе"]);
    // Личная доска не видна другим; «Мои задачи» не удаляется.
    expect((await get(admin, `/api/v1/boards/${mine.id}`)).status).toBe(404);
    expect((await send(anna, "DELETE", `/api/v1/boards/${mine.id}`)).status).toBe(409);
    // У Бена — своя «Мои задачи».
    const ben = (await signIn(app, { login: "ben" })).user;
    const bens = (await get<{ items: BoardSummary[] }>(ben, "/api/v1/boards")).body.items;
    const benMine = bens.find((item) => item.kind === "mine") as BoardSummary;
    expect(benMine.id).not.toBe(mine.id);
    expect(titles(await view(ben, benMine.id))).toEqual(["Чужая"]);
  });

  test("detail level, collapsed zones and hidden levels are personal: the board does not change for others", async () => {
    const { board } = await world();
    const frogsBoard = await board(admin, "Жабы", "team = Frogs");
    const anna = (await signIn(app, { login: "anna" })).user;
    const prefs = {
      detail: 3,
      collapsed: ["Discovery"],
      hiddenLevels: [1],
      density: "compact",
      chipsOff: ["type:type-bug"],
      lanes: "assignee",
      lanesCollapsed: [],
    };
    const saved = await send(anna, "PUT", `/api/v1/boards/${frogsBoard.id}/prefs`, prefs);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await view(anna, frogsBoard.id)).prefs).toMatchObject(prefs);
    // У админа — стартовые настройки, у доски — своя раскладка.
    const theirs = await view(admin, frogsBoard.id);
    expect(theirs.prefs).toMatchObject({ detail: 2, collapsed: [], hiddenLevels: [], density: "normal", lanes: null });
    expect(theirs.board.lanes).toBe("none");
    // Детализация 1 / 2 / 3 по стартовому дереву R-5.1.
    const zones = theirs.board.zones;
    expect(boardLayout(zones, { detail: 1, collapsed: [], hiddenLevels: [] }).columns.map((c) => c.name)).toEqual([
      "Discovery",
      "Delivery",
      "Done",
    ]);
    expect(boardLayout(zones, { detail: 2, collapsed: [], hiddenLevels: [] }).columns.map((c) => c.name)).toEqual([
      "Бэклог",
      "Discovery",
      "To Do",
      "Проработка",
      "Производство",
      "Тест",
      "Готово",
    ]);
    const deep = boardLayout(zones, { detail: 3, collapsed: ["Discovery"], hiddenLevels: [] });
    expect(deep.columns.map((c) => c.name)).toContain("Creation Done");
    expect(deep.columns[0]?.name).toBe("Discovery");
    expect(deep.rows).toBe(3);
    expect(boardLayout(zones, { detail: 3, collapsed: [], hiddenLevels: [1] }).rows).toBe(2);
  });
});

describe("moving cards between zones", () => {
  test("a story dropped into «Production» asks for Creation or Implementation, then moves", async () => {
    const { frogs, create, board } = await world();
    const story = await create("Переключение персонажа", "story", {
      values: { team: frogs.id, due_date: nextWeek },
    });
    const frogsBoard = await board(admin, "Жабы", "team = Frogs");
    const anna = (await signIn(app, { login: "anna" })).user;
    const card = (await view(anna, frogsBoard.id)).cards[0];
    expect(card?.canMove).toBe(true);

    const ask = await send(anna, "POST", `/api/v1/boards/${frogsBoard.id}/move`, {
      key: story.key,
      version: card?.version,
      zoneId: "Production",
    });
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe("status_choice_required");
    expect(ask.body.candidates?.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Creation", "Implementation"]),
    );
    const creation = ask.body.candidates?.find((item) => item.name === "Creation");
    const moved = await send<{ ticket: Ticket }>(anna, "POST", `/api/v1/boards/${frogsBoard.id}/move`, {
      key: story.key,
      version: card?.version,
      zoneId: "Production",
      statusId: creation?.id,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await view(anna, frogsBoard.id)).cards[0]?.statusName).toBe("Creation");
    // Старая версия — конфликт, а не тихая перезапись (R-3.1).
    const stale = await send(anna, "POST", `/api/v1/boards/${frogsBoard.id}/move`, {
      key: story.key,
      version: card?.version,
      zoneId: "Test",
    });
    expect(stale.body.code).toBe("version_conflict");
  });

  test("a bug cannot be dropped into «Elaboration» where it has no status; the reason is explained", async () => {
    const { frogs, create, board } = await world();
    const bug = await create("Камера дёргается", "bug", { values: { team: frogs.id } });
    const frogsBoard = await board(admin, "Жабы", "team = Frogs");
    const refused = await send(admin, "POST", `/api/v1/boards/${frogsBoard.id}/move`, {
      key: bug.key,
      version: bug.version,
      zoneId: "Elaboration",
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "zone_not_for_type", zone: "Проработка", ticketType: "Баг" });
    expect(refused.body.detail).toMatch(/no status in the zone «Проработка»/);
    // В зону из одного статуса для типа — без вопросов (в «Готово» — с исходом).
    const ok = await send(admin, "POST", `/api/v1/boards/${frogsBoard.id}/move`, {
      key: bug.key,
      version: bug.version,
      zoneId: "Ready",
      outcome: "fixed",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  test("entry requirements still apply: dropping into Creation without a due date is blocked with the reason", async () => {
    const { frogs, create, board, type } = await world();
    const story = await create("Без срока", "story", { values: { team: frogs.id } });
    const frogsBoard = await board(admin, "Жабы", "team = Frogs");
    const scheme = (await get<StatusScheme>(admin, `/api/v1/ticket-types/${type("story")}/scheme`)).body;
    const creation = scheme.statuses.find((item) => item.name === "Creation");
    const blocked = await send(admin, "POST", `/api/v1/boards/${frogsBoard.id}/move`, {
      key: story.key,
      version: story.version,
      zoneId: "Production",
      statusId: creation?.id,
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe("transition_blocked");
  });

  test("manual order is stable and shared by everyone who opens the board", async () => {
    const { frogs, create, board } = await world();
    const one = await create("Один", "story", { values: { team: frogs.id } });
    const two = await create("Два", "story", { values: { team: frogs.id } });
    const three = await create("Три", "story", { values: { team: frogs.id } });
    const frogsBoard = await board(admin, "Жабы", "team = Frogs", undefined, { sort: "manual" });
    const order = [three.key, one.key, two.key];
    expect((await send(admin, "POST", `/api/v1/boards/${frogsBoard.id}/order`, { order })).status).toBe(204);
    const anna = (await signIn(app, { login: "anna" })).user;
    const ranked = (await view(anna, frogsBoard.id)).cards
      .slice()
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((card) => card.key);
    expect(ranked).toEqual(order);
  });
});

describe("zones", () => {
  test("a status without a zone goes to «Not mapped»; the zone tree can be rebuilt by the board owner", async () => {
    const { frogs, create, board, type, status } = await world();
    // Админ добавил «Review» в схему бага и не привязал к зоне (схему здесь правим прямо в базе).
    void type;
    app.db
      .prepare(
        `INSERT INTO scheme_statuses (id, scheme_id, name, category, waiting, outcomes, requirements, responsible_roles, freeze_requirements, position)
         VALUES ('status-bug-review', 'scheme-bug', 'Review', 'in_progress', 0, '[]', '[]', '[]', 0, 50)`,
      )
      .run();
    const bug = await create("Баг на ревью", "bug", { values: { team: frogs.id } });
    await status(bug, "Review");
    const frogsBoard = await board(admin, "Жабы", "team = Frogs");
    const seen = await view(admin, frogsBoard.id);
    const card = seen.cards.find((item) => item.key === bug.key);
    expect(card?.statusName).toBe("Review");
    const layout = boardLayout(
      seen.board.zones,
      seen.prefs,
      seen.cards.map((item) => item.statusName),
    );
    expect(layout.unmapped).toEqual(["Review"]);
    expect(layout.columns.at(-1)?.statuses).toEqual(["Review"]);

    // Владелец привязывает «Review» к «Тесту» — колонка «Не сопоставлено» исчезает.
    const zones = seen.board.zones.map((zone) =>
      zone.id === "Test" ? { ...zone, statuses: [...zone.statuses, "Review"], wipLimit: 4 } : zone,
    );
    const rebuilt = await send<Board>(admin, "PUT", `/api/v1/boards/${frogsBoard.id}/zones`, { zones });
    expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
    expect(rebuilt.body.zones.find((zone) => zone.id === "Test")).toMatchObject({ wipLimit: 4 });
    expect(boardLayout(rebuilt.body.zones, seen.prefs, ["Review"]).unmapped).toEqual([]);
    // Один статус — в одной зоне; цикл в дереве — ошибка.
    const twice = await send(admin, "PUT", `/api/v1/boards/${frogsBoard.id}/zones`, {
      zones: zones.map((zone) => (zone.id === "Ready" ? { ...zone, statuses: ["Done", "Test"] } : zone)),
    });
    expect(twice.status).toBe(400);
    const cycle = await send(admin, "PUT", `/api/v1/boards/${frogsBoard.id}/zones`, {
      zones: [
        { id: "a", name: "A", parentId: "b", statuses: [] },
        { id: "b", name: "B", parentId: "a", statuses: [] },
      ],
    });
    expect(cycle.status).toBe(400);
  });

  test("overdue cards are flagged; finished ones older than N days leave the board", async () => {
    const { frogs, create, board, status } = await world();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await create("Просрочена", "story", { values: { team: frogs.id }, endDate: yesterday });
    const old = await create("Давно готова", "task", { values: { team: frogs.id } });
    await status(old, "Done");
    app.db
      .prepare("UPDATE tickets SET status_changed_at = ? WHERE key = ?")
      .run(Date.now() - 20 * 24 * 60 * 60 * 1000, old.key);
    const fresh = await create("Только что готова", "task", { values: { team: frogs.id } });
    await status(fresh, "Done");
    const frogsBoard = await board(admin, "Жабы", "team = Frogs");
    const seen = await view(admin, frogsBoard.id);
    expect(titles(seen)).toEqual(["Просрочена", "Только что готова"]);
    expect(seen.hiddenDone).toBe(1);
    expect(seen.cards.find((card) => card.title === "Просрочена")?.overdue).toBe(true);
    expect(seen.cards.find((card) => card.title === "Только что готова")?.overdue).toBe(false);
    // N настраивается на доску.
    await send(admin, "PATCH", `/api/v1/boards/${frogsBoard.id}`, { doneDays: 30 });
    expect((await view(admin, frogsBoard.id)).hiddenDone).toBe(0);
  });
});

describe("rights and creating from a board", () => {
  test("space boards need the «Configure space boards» right; cards follow the viewer's rights", async () => {
    const { production, board } = await world();
    const anna = (await signIn(app, { login: "anna" })).user;
    const refused = await send(anna, "POST", "/api/v1/boards", {
      name: "Моя",
      query: "type = story",
      spaceId: production,
    });
    expect(refused.status).toBe(403);
    // Личную доску может завести каждый.
    const personal = await board(anna, "Личная", "type = story", null);
    expect(personal.owner).toMatchObject({ kind: "person" });
    const spaceBoard = await board(admin, "Жабы", "team = Frogs");
    expect((await view(anna, spaceBoard.id)).board.canEdit).toBe(false);
    expect((await send(anna, "PATCH", `/api/v1/boards/${spaceBoard.id}`, { name: "x" })).status).toBe(403);
  });

  test("«Create» on the Frogs board takes the team from the filter, so the card lands on the board", async () => {
    const { board, type } = await world();
    const frogsBoard = await board(admin, "Жабы", "team = Frogs or involvedTeams = Frogs");
    const created = await send<{ ticket: Ticket; onBoard: boolean }>(
      admin,
      "POST",
      `/api/v1/boards/${frogsBoard.id}/tickets`,
      { typeId: type("story"), title: "Новая стори Жаб" },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.onBoard).toBe(true);
    expect(titles(await view(admin, frogsBoard.id))).toContain("Новая стори Жаб");
  });
});

describe("live changes", () => {
  test("another person's change reaches an open board as a server-sent event, without data inside", async () => {
    const { frogs, create, board } = await world();
    const story = await create("Живая", "story", { values: { team: frogs.id } });
    const frogsBoard = await board(admin, "Жабы", "team = Frogs");
    const anna = (await signIn(app, { login: "anna" })).user;
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/v1/events`, {
      headers: { cookie: anna.jar.header() },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const waitFor = async (needle: string) => {
      while (!text.includes(needle)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    };
    try {
      await waitFor("retry:");
      const moved = await send(admin, "POST", `/api/v1/boards/${frogsBoard.id}/move`, {
        key: story.key,
        version: story.version,
        zoneId: "Ready",
        outcome: "done",
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      await waitFor("event: tickets");
      expect(text).toContain("event: tickets\ndata: {}");
      expect(text).not.toContain(story.key);
    } finally {
      controller.abort();
    }
  });
});

/** YT-17: дорожки и чипы по любому разрезу, ссылка с состоянием (R-2.18, R-2.14). */
describe("lanes, chips and links", () => {
  test("the urgent filter lane and a TQL chip return their cards within the viewer's rights; a broken query is not saved", async () => {
    const { frogs, pigs, gd, create, board, person } = await world();
    const urgent = await create("Сервер падает", "story", { values: { team: frogs.id }, priority: "highest" });
    await create("Обычная стори", "story", { values: { team: frogs.id } });
    const gdWork = await create("Стори лида", "story", {
      values: { team: pigs.id, stream: [gd.id] },
      people: { assigneeIds: [person("ben").id] },
    });
    const lead = await board(admin, "Лид ГД", "team = Frogs or stream = GD", undefined, {
      lanes: "team",
      chips: ["team", "type"],
      tqlLanes: [{ id: "urgent", name: "Срочно", query: "priority = Urgent" }],
      tqlChips: [{ id: "gd", name: "Только люди колодца ГД", query: "assignee.guild = GD" }],
    });
    expect(lead).toMatchObject({ tqlLanes: [{ name: "Срочно" }], tqlChips: [{ name: "Только люди колодца ГД" }] });
    const seen = await view(admin, lead.id);
    const keyOf = (ids: string[]) => ids.map((id) => seen.cards.find((card) => card.id === id)?.key);
    expect(keyOf(seen.laneHits.urgent ?? [])).toEqual([urgent.key]);
    expect(keyOf(seen.chipHits.gd ?? [])).toEqual([gdWork.key]);

    // Тикет лида закрыт до «только заголовок»: Анна не видит его ни на доске, ни в попаданиях чипа.
    const hidden = (await get<Ticket>(admin, `/api/v1/tickets/${gdWork.key}`)).body;
    const closed = await send(admin, "PUT", `/api/v1/tickets/${gdWork.key}/visibility`, {
      version: hidden.version,
      visibility: "title_only",
      allow: [],
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const anna = (await signIn(app, { login: "anna" })).user;
    const annaView = await view(anna, lead.id);
    expect(annaView.cards.map((card) => card.key)).not.toContain(gdWork.key);
    expect(annaView.chipHits.gd).toEqual([]);

    const broken = await send(admin, "PATCH", `/api/v1/boards/${lead.id}`, {
      tqlLanes: [{ id: "x", name: "Сломано", query: "priority = " }],
    });
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe("tql_invalid");
    const badLanes = await send(admin, "PATCH", `/api/v1/boards/${lead.id}`, { lanes: "field:Не так" });
    expect(badLanes.status).toBe(400);
  });

  test("a link with a refined filter (?q=) shows the colleague the same subset within their rights", async () => {
    const { frogs, pigs, create, board } = await world();
    await create("Жабья срочная", "story", { values: { team: frogs.id }, priority: "highest" });
    await create("Жабья обычная", "story", { values: { team: frogs.id } });
    const closed = await create("Срочная Хрюшек", "story", { values: { team: pigs.id }, priority: "highest" });
    await send(admin, "PUT", `/api/v1/tickets/${closed.key}/visibility`, {
      version: closed.version,
      visibility: "title_only",
      allow: [],
    });
    const all = await board(admin, "Все команды", "team = Frogs or team = Pigs");
    const url = `/api/v1/boards/${all.id}?q=${encodeURIComponent("priority = Urgent")}`;
    const mine = (await get<BoardView>(admin, url)).body;
    expect(titles(mine)).toEqual(["Жабья срочная", "Срочная Хрюшек"]);
    expect(mine.refine).toBe("priority = Urgent");
    const anna = (await signIn(app, { login: "anna" })).user;
    expect(titles((await get<BoardView>(anna, url)).body)).toEqual(["Жабья срочная"]);
    const broken = await get(admin, `/api/v1/boards/${all.id}?q=${encodeURIComponent("priority =")}`);
    expect(broken.status).toBe(400);
  });

  test("lanes and chips by any dimension: card values come with labels from the dictionary (R-2.14)", async () => {
    const { frogs, create, board } = await world();
    const db = app.db;
    const now = Date.now();
    db.prepare(
      `INSERT INTO dimensions (id, key, name, kind, source, multiple, is_system, is_test, created_at, updated_at)
       VALUES ('dim-location', 'location', 'Локация', 'list', NULL, 0, 0, 0, ?, ?)`,
    ).run(now, now);
    db.prepare(
      "INSERT INTO dimension_options (id, dimension_id, label, position) VALUES ('opt-swamp', 'dim-location', 'Болото', 0)",
    ).run();
    db.prepare(
      `INSERT INTO ticket_fields (id, key, name, kind, multiple, scale_id, dimension_id, is_system, is_test, created_at, updated_at)
       VALUES ('field-location', 'location', 'Локация', 'dimension', 0, NULL, 'dim-location', 0, 0, ?, ?)`,
    ).run(now, now);
    const swamp = await create("Квест на болоте", "story", { values: { team: frogs.id } });
    db.prepare("UPDATE tickets SET field_values = json_set(field_values, '$.location', 'opt-swamp') WHERE key = ?").run(
      swamp.key,
    );
    await create("Без локации", "story", { values: { team: frogs.id } });
    const frogsBoard = await board(admin, "Жабы", "team = Frogs", undefined, {
      lanes: "field:location",
      chips: ["field:location", "tags", "assignee"],
    });
    const seen = await view(admin, frogsBoard.id);
    expect(seen.board).toMatchObject({ lanes: "field:location", chips: ["field:location", "tags", "assignee"] });
    expect(seen.dimensions).toEqual([{ key: "location", name: "Локация" }]);
    expect(seen.cards.find((card) => card.key === swamp.key)?.dims).toEqual({
      location: [{ id: "opt-swamp", name: "Болото" }],
    });
  });
});
