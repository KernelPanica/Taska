import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  HistoryEntry,
  StatusScheme,
  Ticket,
  TicketSummary,
  TicketTree,
  TicketType,
  WorkflowStatus,
} from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-09 (иерархия и дерево) и YT-10 (свёртки) через API. */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

type Body<T> = T & { code?: string; detail?: string; errors?: { field: string; message: string }[] };
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => {
  const response = await user.request("GET", url);
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
};

async function kit(user = admin) {
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).body.items;
  const type = (key: string) => (types.find((item) => item.key === key) as TicketType).id;
  const create = async (title: string, typeKey = "task", extra: Record<string, unknown> = {}) => {
    const created = await send<Ticket>(user, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: type(typeKey),
      title,
      ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
  };
  const fresh = async (key: string) => (await get<Ticket>(admin, `/api/v1/tickets/${key}`)).body;
  const scheme = async (ticket: Ticket) =>
    (await get<StatusScheme>(admin, `/api/v1/ticket-types/${ticket.typeId}/scheme?spaceId=${ticket.spaceId}`)).body;
  const statusIn = async (ticket: Ticket, category: WorkflowStatus["category"]) =>
    (await scheme(ticket)).statuses.find((status) => status.category === category && !status.waiting) as WorkflowStatus;
  /** Перевести тикет в первую «в работе» или в «завершён» (с первым исходом, не отменой). */
  const move = async (key: string, category: WorkflowStatus["category"]) => {
    const ticket = await fresh(key);
    const status = await statusIn(ticket, category);
    const outcome = status.outcomes.find((item) => item !== "cancelled");
    const moved = await send<Ticket>(admin, "POST", `/api/v1/tickets/${key}/transition`, {
      version: ticket.version,
      statusId: status.id,
      ...(outcome ? { outcome } : {}),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    return moved.body;
  };
  const link = async (child: string, parent: string) => {
    const linked = await send<Ticket>(admin, "POST", `/api/v1/tickets/${child}/parents`, { parentKey: parent });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    return linked.body;
  };
  const statusName = async (ticket: Ticket) =>
    (await scheme(ticket)).statuses.find((status) => status.id === ticket.statusId)?.name;
  return { type, create, fresh, move, link, statusIn, statusName };
}

describe("hierarchy (YT-09, R-2.8)", () => {
  test("a tree six levels deep is created and shown", async () => {
    const { create } = await kit();
    let parent: Ticket | null = null;
    const keys: string[] = [];
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const ticket: Ticket = await create(`Уровень ${level}`, "task", parent ? { parentKey: parent.key } : {});
      keys.push(ticket.key);
      parent = ticket;
    }
    const tree = (await get<TicketTree>(admin, "/api/v1/tree?spaceId=space-production")).body;
    let id = tree.roots.find((root) => tree.nodes[root]?.key === keys[0]) as string;
    const path = [tree.nodes[id]?.key];
    while (tree.children[id]?.length) {
      id = tree.children[id]?.[0] as string;
      path.push(tree.nodes[id]?.key);
    }
    expect(path).toEqual(keys);
  });

  test("a ticket with two parents is listed under both and edited in one place", async () => {
    const { create, link, fresh } = await kit();
    const combat = await create("Боевая система", "epic");
    const ui = await create("Интерфейс боя", "epic");
    const story = await create("Переключение персонажа", "story", { parentKey: combat.key });
    await link(story.key, ui.key);
    const tree = (await get<TicketTree>(admin, "/api/v1/tree?spaceId=space-production")).body;
    const id = Object.values(tree.nodes).find((node) => node.key === story.key)?.id as string;
    expect(tree.nodes[id]?.parentCount).toBe(2);
    const underCombat = tree.children[Object.values(tree.nodes).find((node) => node.key === combat.key)?.id as string];
    const underUi = tree.children[Object.values(tree.nodes).find((node) => node.key === ui.key)?.id as string];
    expect(underCombat).toContain(id);
    expect(underUi).toContain(id);
    const current = await fresh(story.key);
    await send(admin, "PATCH", `/api/v1/tickets/${story.key}`, { version: current.version, title: "Смена героя" });
    expect((await fresh(combat.key)).relations.children).toMatchObject([{ key: story.key, title: "Смена героя" }]);
    expect((await fresh(ui.key)).relations.children).toMatchObject([{ key: story.key, title: "Смена героя" }]);
    expect((await fresh(story.key)).relations.parents.map((item) => (item.available ? item.key : null))).toEqual([
      combat.key,
      ui.key,
    ]);
  });

  test("the system refuses to make a ticket its own ancestor", async () => {
    const { create } = await kit();
    const a = await create("A");
    const b = await create("B", "task", { parentKey: a.key });
    const c = await create("C", "task", { parentKey: b.key });
    const cycle = await send(admin, "POST", `/api/v1/tickets/${a.key}/parents`, { parentKey: c.key });
    expect(cycle.status).toBe(422);
    expect(cycle.body.code).toBe("hierarchy_cycle");
    const self = await send(admin, "POST", `/api/v1/tickets/${a.key}/parents`, { parentKey: a.key });
    expect(self.body.code).toBe("hierarchy_cycle");
  });

  test("type rules are checked when linking, where the space switched them on", async () => {
    const { create, type } = await kit();
    const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).body.items;
    const story = types.find((item) => item.key === "story") as TicketType;
    await send(admin, "PATCH", `/api/v1/ticket-types/${story.id}`, { allowedParentTypeIds: [type("epic")] });
    await send(admin, "PATCH", "/api/v1/spaces/space-production", { enforceSubordination: true });
    const task = await create("Задача-родитель");
    const child = await create("Стори", "story");
    const refused = await send(admin, "POST", `/api/v1/tickets/${child.key}/parents`, { parentKey: task.key });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("subordination_violation");
    const epic = await create("Эпик", "epic");
    expect((await send(admin, "POST", `/api/v1/tickets/${child.key}/parents`, { parentKey: epic.key })).status).toBe(
      200,
    );
  });

  test("«wrap in a parent»: three stories of an epic move under a new ticket that goes under the epic; history is kept", async () => {
    const { create, fresh, type } = await kit();
    const epic = await create("Боевая система", "epic");
    const stories = [];
    for (const title of ["Удар", "Блок", "Уклон"]) stories.push(await create(title, "story", { parentKey: epic.key }));
    const wrapped = await send<Ticket>(admin, "POST", "/api/v1/tickets/wrap", {
      keys: stories.map((story) => story.key),
      fromParentKey: epic.key,
      title: "Ближний бой",
      typeId: type("epic"),
    });
    expect(wrapped.status).toBe(201);
    expect(wrapped.body.relations.parents).toMatchObject([{ key: epic.key }]);
    expect(wrapped.body.relations.children.map((item) => (item.available ? item.key : null))).toEqual(
      stories.map((story) => story.key),
    );
    expect((await fresh(epic.key)).relations.children.map((item) => (item.available ? item.key : null))).toEqual([
      wrapped.body.key,
    ]);
    const history = (await get<{ items: HistoryEntry[] }>(admin, `/api/v1/tickets/${stories[0]?.key}/history`)).body
      .items;
    // Вся прежняя история на месте, плюс записи о смене родителя.
    expect(history.some((entry) => entry.field === "created")).toBe(true);
    expect(
      history
        .filter((entry) => entry.field === "parents")
        .map((entry) => [entry.from?.text ?? null, entry.to?.text ?? null]),
    ).toEqual([
      [null, `${wrapped.body.key} Ближний бой`],
      [`${epic.key} Боевая система`, null],
      [null, `${epic.key} Боевая система`],
    ]);
  });

  test("the topmost ticket gets a parent above it; coverage counts goals among the ancestors", async () => {
    const { create, link } = await kit();
    const epic = await create("Боевая система", "epic");
    const story = await create("Комбо", "story", { parentKey: epic.key });
    // «+ родитель» одной строкой над самым верхним.
    const goal = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: (await kit()).type("goal"),
      title: "Альфа к марту",
      childKey: epic.key,
    });
    expect(goal.status).toBe(201);
    expect(goal.body.relations.children).toMatchObject([{ key: epic.key }]);
    const second = await create("Демо для издателя", "goal");
    await link(story.key, second.key);
    const list = (
      await get<{ items: TicketSummary[] }>(admin, "/api/v1/tickets?spaceId=space-production&sort=coverage")
    ).body.items;
    expect(list[0]).toMatchObject({ key: story.key, coverage: 2 });
    expect(list.find((item) => item.key === epic.key)?.coverage).toBe(1);
    const filtered = (
      await get<{ items: TicketSummary[] }>(admin, "/api/v1/tickets?spaceId=space-production&minCoverage=2")
    ).body.items;
    expect(filtered.map((item) => item.key)).toEqual([story.key]);
  });

  test("a branch of 50 tickets moves in one operation", async () => {
    const { create, fresh } = await kit();
    const root = await create("Ветка");
    let level = [root];
    let count = 1;
    while (count < 50) {
      const next: Ticket[] = [];
      for (const parent of level) {
        for (let index = 0; index < 3 && count < 50; index += 1, count += 1) {
          next.push(await create(`Узел ${count}`, "task", { parentKey: parent.key }));
        }
      }
      level = next;
    }
    const target = await create("Новый родитель", "epic");
    const started = Date.now();
    const moved = await send<{ items: Ticket[] }>(admin, "POST", "/api/v1/tickets/move", {
      keys: [root.key],
      toParentKey: target.key,
    });
    expect(moved.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    const tree = (await get<TicketTree>(admin, `/api/v1/tree?rootKey=${target.key}`)).body;
    expect(Object.values(tree.nodes).filter((node) => node.available)).toHaveLength(51);
    expect((await fresh(root.key)).relations.parents).toMatchObject([{ key: target.key }]);
  });

  test("one line in Core creates the child «Contract» in Direction; a Core member sees only «unavailable»", async () => {
    const { type } = await kit();
    const onboarding = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-core",
      typeId: type("task"),
      title: "Онбординг Веры",
    });
    const started = Date.now();
    const contract = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-direction",
      typeId: type("task"),
      title: "Договор",
      parentKey: onboarding.body.key,
    });
    expect(contract.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(500);
    expect(contract.body.spaceId).toBe("space-direction");
    expect((await get<Ticket>(admin, `/api/v1/tickets/${onboarding.body.key}`)).body.relations.children).toMatchObject([
      { available: true, key: contract.body.key, spaceName: "Дирекция" },
    ]);

    // Бен — ПМ Лис: в Core у него права ПМа, в Дирекцию доступа нет.
    const ben = (await signIn(app, { login: "ben" })).user;
    const card = await get<Ticket>(ben, `/api/v1/tickets/${onboarding.body.key}`);
    expect(card.status).toBe(200);
    expect(card.body.relations.children).toEqual([{ available: false }]);
    const tree = await get<TicketTree>(ben, `/api/v1/tree?rootKey=${onboarding.body.key}`);
    expect(JSON.stringify(tree.body)).not.toContain(contract.body.key);
    expect(JSON.stringify(tree.body)).not.toContain("Договор");
    expect(JSON.stringify(tree.body)).not.toContain(contract.body.id);
    const history = await get<{ items: HistoryEntry[] }>(ben, `/api/v1/tickets/${onboarding.body.key}/history`);
    expect(JSON.stringify(history.body)).not.toContain("Договор");
    expect((await get(ben, `/api/v1/tickets/${contract.body.key}`)).status).toBe(404);
    // Спаces для «+ ребёнок»: Дирекция Бену не предлагается — права «Создавать» там нет.
    const spaces = (await get<{ items: { slug: string; rights: string[] }[] }>(ben, "/api/v1/spaces")).body.items;
    expect(spaces.filter((space) => space.rights.includes("create")).map((space) => space.slug)).not.toContain(
      "direction",
    );
  });

  test("remove one parent link and keep the others", async () => {
    const { create, link, fresh } = await kit();
    const a = await create("A", "epic");
    const b = await create("B", "epic");
    const child = await create("C", "task", { parentKey: a.key });
    await link(child.key, b.key);
    const removed = await send<Ticket>(admin, "DELETE", `/api/v1/tickets/${child.key}/parents/${a.key}`);
    expect(removed.status).toBe(200);
    expect(removed.body.relations.parents).toMatchObject([{ key: b.key }]);
    expect((await fresh(a.key)).relations.children).toEqual([]);
  });
});

describe("rollups (YT-10, R-2.12)", () => {
  test("the first child in work moves the epic to In Progress, the history says «rollup»", async () => {
    const { create, move, fresh, statusName } = await kit();
    const epic = await create("Боевая система", "epic");
    const story = await create("Удар", "task", { parentKey: epic.key });
    await create("Блок", "task", { parentKey: epic.key });
    await move(story.key, "in_progress");
    const after = await fresh(epic.key);
    expect(await statusName(after)).toBe("In Progress");
    const entry = (await get<{ items: HistoryEntry[] }>(admin, `/api/v1/tickets/${epic.key}/history`)).body.items.find(
      (item) => item.field === "status" && item.source === "system",
    );
    expect(entry).toMatchObject({ source: "system", sourceDetail: "rollup" });
  });

  test("all children closed → a flag, the epic stays open; a child back in work → the epic too", async () => {
    const { create, move, fresh, statusName } = await kit();
    const epic = await create("Эпик", "epic");
    const a = await create("A", "task", { parentKey: epic.key });
    const b = await create("B", "task", { parentKey: epic.key });
    await move(a.key, "done");
    expect((await fresh(epic.key)).rollup.closeSuggested).toBe(false);
    await move(b.key, "done");
    const flagged = await fresh(epic.key);
    expect(flagged.rollup.closeSuggested).toBe(true);
    expect((await statusName(flagged)) === "Done").toBe(false);

    // ПМ закрывает эпик — флаг уходит; ребёнка вернули в работу — эпик тоже.
    await move(epic.key, "done");
    expect((await fresh(epic.key)).rollup.closeSuggested).toBe(false);
    await move(b.key, "in_progress");
    const reopened = await fresh(epic.key);
    expect(await statusName(reopened)).toBe("In Progress");
    expect(reopened.rollup.closeSuggested).toBe(false);
  });

  test("a shared child moves both parents", async () => {
    const { create, move, fresh, link, statusName } = await kit();
    const one = await create("Эпик 1", "epic");
    const two = await create("Эпик 2", "epic");
    const shared = await create("Общий", "task", { parentKey: one.key });
    await link(shared.key, two.key);
    await move(shared.key, "in_progress");
    expect(await statusName(await fresh(one.key))).toBe("In Progress");
    expect(await statusName(await fresh(two.key))).toBe("In Progress");
  });

  test("three children and two own checklist items give the right percent; a checklist child counts once; cancelled children are out", async () => {
    const { create, move, fresh } = await kit();
    // У стори прогресс по детям и чеклисту («оба»).
    const story = await create("Стори", "story");
    const a = await create("A", "task", { parentKey: story.key });
    await create("B", "task", { parentKey: story.key });
    const c = await create("C", "task", { parentKey: story.key });
    const current = await fresh(story.key);
    const patched = await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${story.key}`, {
      version: current.version,
      checklist: [
        { text: "Сам пункт 1", done: true },
        { text: "Сам пункт 2", done: false },
        { text: "Пункт-ребёнок", done: false, childKey: a.key },
      ],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.rollup.progress).toEqual({ done: 1, total: 5, percent: 20 });
    expect(patched.body.relations.children.find((item) => item.available && item.key === a.key)).toMatchObject({
      inChecklist: true,
    });

    await move(a.key, "done");
    const after = await fresh(story.key);
    expect(after.rollup.progress).toEqual({ done: 2, total: 5, percent: 40 });
    expect(after.checklist.find((item) => item.childKey === a.key)?.done).toBe(true);

    // Отменённый ребёнок не тянет прогресс вниз.
    const cTicket = await fresh(c.key);
    await send(admin, "POST", `/api/v1/tickets/${c.key}/cancel`, { version: cTicket.version, reason: "не нужно" });
    expect((await fresh(story.key)).rollup.progress).toEqual({ done: 2, total: 4, percent: 50 });

    // Пункт-ребёнок ссылается только на ребёнка.
    const wrong = await send(admin, "PATCH", `/api/v1/tickets/${story.key}`, {
      version: (await fresh(story.key)).version,
      checklist: [{ text: "Чужой", done: false, childKey: story.key }],
    });
    expect(wrong.status).toBe(400);
  });

  test("dates: earliest start and latest end of children; manual dates are kept apart and the difference is flagged", async () => {
    const { create, fresh } = await kit();
    const epic = await create("Эпик", "epic");
    const a = await create("A", "task", { parentKey: epic.key });
    const b = await create("B", "task", { parentKey: epic.key });
    await send(admin, "PATCH", `/api/v1/tickets/${a.key}`, {
      version: a.version,
      startDate: "2026-11-03",
      endDate: "2026-11-10",
    });
    await send(admin, "PATCH", `/api/v1/tickets/${b.key}`, {
      version: b.version,
      startDate: "2026-11-05",
      endDate: "2026-11-21",
    });
    const rolled = await fresh(epic.key);
    expect(rolled.rollup).toMatchObject({ startDate: "2026-11-03", endDate: "2026-11-21", datesDiffer: false });
    expect(rolled.startDate).toBeNull();
    const manual = await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${epic.key}`, {
      version: rolled.version,
      startDate: "2026-11-01",
      endDate: "2026-11-21",
    });
    expect(manual.body).toMatchObject({
      startDate: "2026-11-01",
      rollup: { startDate: "2026-11-03", datesDiffer: true },
    });
  });

  test("estimates: the sum of children through the converter", async () => {
    const { create, fresh } = await kit();
    const epic = await create("Эпик", "epic");
    for (const days of [2, 3]) {
      const story = await create(`Стори ${days}`, "story", { parentKey: epic.key });
      await send(admin, "PATCH", `/api/v1/tickets/${story.key}`, {
        version: story.version,
        values: { estimate_days: days },
      });
    }
    expect((await fresh(epic.key)).rollup.estimates.estimate_days).toMatchObject({ min: 5, max: 5 });
  });

  test("a child in another space moves the rollup; a viewer without access sees the progress but not the child", async () => {
    const { create, move, fresh, type } = await kit();
    const epic = await create("Эпик", "epic");
    await create("Видимая", "task", { parentKey: epic.key });
    const hidden = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-direction",
      typeId: type("task"),
      title: "Договор с издателем",
      parentKey: epic.key,
    });
    await move(hidden.body.key, "done");
    expect((await fresh(epic.key)).rollup.progress).toEqual({ done: 1, total: 2, percent: 50 });
    const anna = (await signIn(app, { login: "anna" })).user;
    const seen = (await get<Ticket>(anna, `/api/v1/tickets/${epic.key}`)).body;
    expect(seen.rollup.progress?.percent).toBe(50);
    expect(seen.relations.children.filter((item) => !item.available)).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain("Договор");
  });

  test("recalculation after editing a tree of 1 000 tickets fits R-3.4 (≤ 2 s)", async () => {
    const { create, fresh } = await kit();
    const root = await create("Корень", "epic");
    // 1 011 тикетов: корень → 10 эпиков → по 10 стори → по 9 задач; создаём прямо в базе ради скорости теста.
    const db = app.db;
    const template = db.prepare("SELECT * FROM tickets WHERE key = ?").get(root.key) as Record<string, unknown>;
    const statuses = db
      .prepare(
        `SELECT ss.id, sc.type_id FROM scheme_statuses ss JOIN status_schemes sc ON sc.id = ss.scheme_id
         WHERE sc.space_id IS NULL ORDER BY ss.position`,
      )
      .all() as { id: string; type_id: string }[];
    const first = (typeKey: string) => {
      const typeId = (db.prepare("SELECT id FROM ticket_types WHERE key = ?").get(typeKey) as { id: string }).id;
      return { typeId, statusId: (statuses.find((status) => status.type_id === typeId) as { id: string }).id };
    };
    let number = 100_000;
    const insert = (typeKey: string, parentId: string) => {
      number += 1;
      const id = `bulk-${number}`;
      const { typeId, statusId } = first(typeKey);
      db.prepare(
        `INSERT INTO tickets (id, number, key, space_id, type_id, status_id, title, is_test, created_at, updated_at, status_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, number, `AOS-${number}`, template.space_id, typeId, statusId, `Тикет ${number}`, 1, 1, 1);
      db.prepare("INSERT INTO ticket_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)").run(id, id);
      db.prepare("INSERT INTO ticket_parents (parent_id, child_id, position, created_at) VALUES (?, ?, ?, 1)").run(
        parentId,
        id,
        number,
      );
      db.prepare(
        `INSERT INTO ticket_closure (ancestor_id, descendant_id, depth)
         SELECT ancestor_id, ?, depth + 1 FROM ticket_closure WHERE descendant_id = ?`,
      ).run(id, parentId);
      return id;
    };
    let leaf = "";
    db.transaction(() => {
      for (let e = 0; e < 10; e += 1) {
        const epic = insert("epic", root.id);
        for (let s = 0; s < 10; s += 1) {
          const story = insert("story", epic);
          for (let t = 0; t < 9; t += 1) leaf = insert("task", story);
        }
      }
    })();
    expect(
      (db.prepare("SELECT count(*) AS n FROM ticket_closure WHERE ancestor_id = ?").get(root.id) as { n: number }).n,
    ).toBe(1011);

    // Перенос ветки внутри дерева и смена статуса листа: оба пересчёта укладываются в 2 с.
    const leafKey = (db.prepare("SELECT key FROM tickets WHERE id = ?").get(leaf) as { key: string }).key;
    const target = await create("Новый эпик", "epic", { parentKey: root.key });
    const started = Date.now();
    const moved = await send(admin, "POST", "/api/v1/tickets/move", { keys: [leafKey], toParentKey: target.key });
    expect(moved.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    const full = Date.now();
    // Полный пересчёт всего дерева (например, после смены настроек свёрток типа).
    const { rollupService } = await import("../src/tickets/rollups.js");
    const { treeStore } = await import("../src/tickets/tree.js");
    const { historyService } = await import("../src/tickets/history.js");
    const ids = (
      db.prepare("SELECT descendant_id AS id FROM ticket_closure WHERE ancestor_id = ?").all(root.id) as {
        id: string;
      }[]
    ).map((row) => row.id);
    db.transaction(() => rollupService(db, treeStore(db), historyService(db)).recompute(ids))();
    expect(Date.now() - full).toBeLessThan(2000);
    expect((await fresh(root.key)).rollup.progress?.total).toBe(11);
  });
});

describe("rollup settings of a type (YT-10)", () => {
  test("switching the progress source of a type recalculates its tickets at once", async () => {
    app = await createTestApp();
    admin = (await signIn(app, { login: "admin" })).user;
    const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).body.items;
    const epicType = types.find((item) => item.key === "epic") as TicketType;
    const taskType = types.find((item) => item.key === "task") as TicketType;
    const epic = (
      await send<Ticket>(admin, "POST", "/api/v1/tickets", {
        spaceId: "space-production",
        typeId: epicType.id,
        title: "Эпик",
      })
    ).body;
    await send(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: taskType.id,
      title: "Ребёнок",
      parentKey: epic.key,
    });
    expect((await get<Ticket>(admin, `/api/v1/tickets/${epic.key}`)).body.rollup.progress).toEqual({
      done: 0,
      total: 1,
      percent: 0,
    });
    await send(admin, "PATCH", `/api/v1/ticket-types/${epicType.id}`, { rollups: { progress: "none" } });
    expect((await get<Ticket>(admin, `/api/v1/tickets/${epic.key}`)).body.rollup.progress).toBeNull();
  });
});
