import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HistoryEntry, Ticket, TicketSummary, TicketTree, TicketType } from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-11: номер в потоке (R-2.9) через API. */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
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
  const create = async (
    title: string,
    typeKey = "task",
    extra: Record<string, unknown> = {},
    space = "space-production",
  ) => {
    const created = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: space,
      typeId: type(typeKey),
      title,
      ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
  };
  const ticket = (key: string) => get<Ticket>(admin, `/api/v1/tickets/${key}`);
  const numbers = async (key: string) => (await ticket(key)).numbers.map((entry) => entry.number);
  return { type, create, ticket, numbers };
}

/** Поток: эпик и десять задач под ним — 1.1 … 1.10. */
async function flow(size = 10) {
  const k = await kit();
  const epic = await k.create("Поток", "epic");
  const tasks: Ticket[] = [];
  for (let index = 1; index <= size; index += 1)
    tasks.push(await k.create(`Шаг ${index}`, "task", { parentKey: epic.key }));
  return { ...k, epic, tasks };
}

describe("flow number (R-2.9)", () => {
  test("the number is the path from the top ancestor: top tickets in the space order, children by order", async () => {
    const { epic, tasks, numbers } = await flow(3);
    expect(await numbers(epic.key)).toEqual(["1"]);
    expect(await Promise.all(tasks.map((task) => numbers(task.key)))).toEqual([["1.1"], ["1.2"], ["1.3"]]);
    const card = await (await kit()).ticket(tasks[1]?.key as string);
    expect(card.numbers).toEqual([{ number: "1.2", parentKey: epic.key }]);
    expect(
      (await (await kit()).ticket(epic.key)).relations.children.map((child) => (child.available ? child.number : null)),
    ).toEqual(["1.1", "1.2", "1.3"]);
  });

  test("a story inserted before 1.3 becomes 1.3, the former 1.3 becomes 1.4 and its children follow; the history says so", async () => {
    const { epic, tasks, create, numbers } = await flow(5);
    const former = tasks[2] as Ticket;
    const grandchild = await create("Подзадача", "task", { parentKey: former.key });
    expect(await numbers(grandchild.key)).toEqual(["1.3.1"]);

    const inserted = await create("Вставленная стори", "story", { parentKey: epic.key, beforeKey: former.key });
    expect(await numbers(inserted.key)).toEqual(["1.3"]);
    expect(await numbers(former.key)).toEqual(["1.4"]);
    expect(await numbers(grandchild.key)).toEqual(["1.4.1"]);
    expect(await numbers((tasks[4] as Ticket).key)).toEqual(["1.6"]);
    expect(await numbers((tasks[1] as Ticket).key)).toEqual(["1.2"]);

    const history = (await get<{ items: HistoryEntry[] }>(admin, `/api/v1/tickets/${former.key}/history`)).items;
    const entry = history.find((item) => item.field === "number");
    expect(entry).toMatchObject({
      source: "system",
      sourceDetail: `number:inserted:${inserted.key}`,
      from: { text: "1.3" },
      to: { text: "1.4" },
    });
    // У тех, кто не сдвинулся, и у самого вставленного строки о номере нет.
    for (const key of [(tasks[1] as Ticket).key, inserted.key]) {
      const items = (await get<{ items: HistoryEntry[] }>(admin, `/api/v1/tickets/${key}/history`)).items;
      expect(items.some((item) => item.field === "number")).toBe(false);
    }
  });

  test("links by key lead to the same tickets after renumbering", async () => {
    const { epic, tasks, create, ticket } = await flow(4);
    const before = await ticket((tasks[3] as Ticket).key);
    await create("В начало", "task", { parentKey: epic.key, beforeKey: (tasks[0] as Ticket).key });
    const after = await ticket((tasks[3] as Ticket).key);
    expect(after).toMatchObject({ id: before.id, key: before.key, title: before.title });
    expect(after.numbers[0]?.number).toBe("1.5");
  });

  test("a ticket with two parents has a number per path", async () => {
    const { create, ticket } = await kit();
    const combat = await create("Боевая система", "epic");
    const ui = await create("Интерфейс боя", "epic");
    await create("Удар", "story", { parentKey: combat.key });
    await create("Блок", "story", { parentKey: combat.key });
    const story = await create("Переключение персонажа", "story", { parentKey: combat.key });
    await send(admin, "POST", `/api/v1/tickets/${story.key}/parents`, { parentKey: ui.key });
    expect((await ticket(story.key)).numbers).toEqual([
      { number: "1.3", parentKey: combat.key },
      { number: "2.1", parentKey: ui.key },
    ]);
    // В связях — «номер здесь».
    expect(
      (await ticket(story.key)).relations.parents.map((parent) =>
        parent.available ? [parent.key, parent.number] : null,
      ),
    ).toEqual([
      [combat.key, "1.3"],
      [ui.key, "2.1"],
    ]);
    const tree = await get<TicketTree>(admin, "/api/v1/tree?spaceId=space-production");
    const node = Object.values(tree.nodes).find((item) => item.key === story.key);
    expect(node?.numbers?.map((entry) => entry.number)).toEqual(["1.3", "2.1"]);
  });

  test("removing a link and moving shift the neighbours; the top order in the space is manual", async () => {
    const { epic, tasks, create, numbers } = await flow(3);
    await send(admin, "DELETE", `/api/v1/tickets/${(tasks[0] as Ticket).key}/parents/${epic.key}`);
    expect(await numbers((tasks[1] as Ticket).key)).toEqual(["1.1"]);
    expect(await numbers((tasks[0] as Ticket).key)).toEqual(["2"]);
    const third = (await get<{ items: HistoryEntry[] }>(admin, `/api/v1/tickets/${(tasks[2] as Ticket).key}/history`))
      .items;
    expect(third.find((item) => item.field === "number")?.sourceDetail).toBe(
      `number:removed:${(tasks[0] as Ticket).key}`,
    );

    // Ручной порядок верхних: «Шаг 1» ставим перед эпиком.
    const other = await create("Ещё эпик", "epic");
    expect(await numbers(other.key)).toEqual(["3"]);
    await send(admin, "POST", "/api/v1/tickets/move", {
      keys: [(tasks[0] as Ticket).key],
      toParentKey: null,
      beforeKey: epic.key,
    });
    expect(await numbers((tasks[0] as Ticket).key)).toEqual(["1"]);
    expect(await numbers(epic.key)).toEqual(["2"]);
    expect(await numbers((tasks[2] as Ticket).key)).toEqual(["2.2"]);

    // Порядок среди детей — перетаскиванием (move с тем же родителем и beforeKey).
    await send(admin, "POST", "/api/v1/tickets/move", {
      keys: [(tasks[2] as Ticket).key],
      fromParentKey: epic.key,
      toParentKey: epic.key,
      beforeKey: (tasks[1] as Ticket).key,
    });
    expect(await numbers((tasks[2] as Ticket).key)).toEqual(["2.1"]);
    expect(await numbers((tasks[1] as Ticket).key)).toEqual(["2.2"]);
  });

  test("the list sorts in flow order", async () => {
    const { epic, tasks, create } = await flow(2);
    await create("Вставка", "task", { parentKey: epic.key, beforeKey: (tasks[0] as Ticket).key });
    const items = (await get<{ items: TicketSummary[] }>(admin, "/api/v1/tickets?spaceId=space-production&sort=flow"))
      .items;
    expect(items.map((item) => [item.numbers[0], item.title])).toEqual([
      ["1", "Поток"],
      ["1.1", "Вставка"],
      ["1.2", "Шаг 1"],
      ["1.3", "Шаг 2"],
    ]);
  });

  test("an unavailable parent is not named next to the number (R-2.17)", async () => {
    const { create, type } = await kit();
    const secret = await create("Бюджет", "task", {}, "space-direction");
    const visible = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: type("task"),
      title: "Открытая задача",
      parentKey: secret.key,
    });
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await get<Ticket>(anna, `/api/v1/tickets/${visible.body.key}`)).numbers).toEqual([
      { number: "1.1", parentKey: null },
    ]);
  });

  test("renumbering a tree of 1 000 tickets fits R-3.4 (≤ 2 s)", async () => {
    const { create, numbers } = await kit();
    const root = await create("Корень", "epic");
    const db = app.db;
    const typeId = (key: string) =>
      (db.prepare("SELECT id FROM ticket_types WHERE key = ?").get(key) as { id: string }).id;
    const status = (key: string) =>
      (
        db
          .prepare(
            "SELECT ss.id FROM scheme_statuses ss JOIN status_schemes sc ON sc.id = ss.scheme_id WHERE sc.type_id = ? AND sc.space_id IS NULL ORDER BY ss.position LIMIT 1",
          )
          .get(typeId(key)) as { id: string }
      ).id;
    let number = 200_000;
    const insert = (key: string, parentId: string, position: number) => {
      number += 1;
      const id = `flow-${number}`;
      db.prepare(
        `INSERT INTO tickets (id, number, key, space_id, type_id, status_id, title, is_test, created_at, updated_at, status_changed_at, root_position)
         VALUES (?, ?, ?, 'space-production', ?, ?, ?, 1, 1, 1, 1, ?)`,
      ).run(id, number, `AOS-${number}`, typeId(key), status(key), `Тикет ${number}`, number);
      db.prepare("INSERT INTO ticket_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)").run(id, id);
      db.prepare("INSERT INTO ticket_parents (parent_id, child_id, position, created_at) VALUES (?, ?, ?, 1)").run(
        parentId,
        id,
        position,
      );
      db.prepare(
        "INSERT INTO ticket_closure (ancestor_id, descendant_id, depth) SELECT ancestor_id, ?, depth + 1 FROM ticket_closure WHERE descendant_id = ?",
      ).run(id, parentId);
      return id;
    };
    let firstEpic = "";
    db.transaction(() => {
      for (let e = 0; e < 10; e += 1) {
        const epic = insert("epic", root.id, e + 1);
        if (!firstEpic) firstEpic = epic;
        for (let s = 0; s < 10; s += 1) {
          const story = insert("story", epic, s + 1);
          for (let t = 0; t < 9; t += 1) insert("task", story, t + 1);
        }
      }
    })();
    const { numberingService } = await import("../src/tickets/numbering.js");
    const { treeStore } = await import("../src/tickets/tree.js");
    const { historyService } = await import("../src/tickets/history.js");
    db.transaction(() =>
      numberingService(db, treeStore(db), historyService(db)).renumber({ parents: [root.id] }, null, false),
    )();

    // Вставка в самое начало: сдвигаются все 1 010 потомков корня.
    const firstKey = (db.prepare("SELECT key FROM tickets WHERE id = ?").get(firstEpic) as { key: string }).key;
    const started = Date.now();
    const inserted = await create("Новый первый эпик", "epic", { parentKey: root.key, beforeKey: firstKey });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await numbers(inserted.key)).toEqual(["1.1"]);
    expect(await numbers(firstKey)).toEqual(["1.2"]);
    const lastTask = (db.prepare("SELECT key FROM tickets WHERE id = ?").get(`flow-${number}`) as { key: string }).key;
    expect(await numbers(lastTask)).toEqual(["1.11.10.9"]);
  });
});
