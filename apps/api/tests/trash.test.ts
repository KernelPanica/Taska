import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AppNotification,
  ChildrenChoice,
  FeatureTeam,
  Guild,
  LinkType,
  Person,
  RelinkResult,
  RestoreResult,
  Space,
  StatusScheme,
  Ticket,
  TicketSummary,
  TicketType,
  TrashItem,
  TrashResult,
  TrashSettings,
  WorkflowStatus,
} from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-14: корзина, удаление родителя, след и пересвязка, права R-5.2 через API. */
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
  choice?: ChildrenChoice;
  count?: number;
  ticket?: { key: string; title: string; canRestore?: boolean };
};
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => {
  const response = await user.request("GET", url);
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
};

async function kit() {
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).body.items;
  const type = (key: string) => (types.find((item) => item.key === key) as TicketType).id;
  const spaces = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).body.items;
  const production = (spaces.find((item) => item.slug === "production") as Space).id;
  const create = async (title: string, kind = "story", user = admin, extra: Record<string, unknown> = {}) => {
    const created = await send<Ticket>(user, "POST", "/api/v1/tickets", {
      spaceId: production,
      typeId: type(kind),
      title,
      ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
  };
  const fresh = async (key: string, user = admin) => get<Ticket>(user, `/api/v1/tickets/${key}`);
  const trash = (user: Client, body: Record<string, unknown>) =>
    send<TrashResult>(user, "POST", "/api/v1/tickets/trash", body);
  const restore = (user: Client, body: Record<string, unknown>) =>
    send<RestoreResult>(user, "POST", "/api/v1/trash/restore", body);
  const parentsOf = async (key: string) =>
    (await fresh(key)).body.relations.parents.map((item) => (item.available ? item.key : "?"));
  /** Эпик «Прототип боя» с двумя детьми, пунктом-ребёнком в чеклисте и связью «блокирует». */
  const epicWithChildren = async () => {
    const epic = await create("Прототип боя", "epic");
    const camera = await create("Скрипт смены камеры", "story", admin, { parentKey: epic.key });
    const switcher = await create("Переключение персонажа в бою", "story", admin, { parentKey: epic.key });
    const combo = await create("Комбо при переключении героя");
    const links = (await get<{ items: LinkType[] }>(admin, "/api/v1/link-types")).body.items;
    const blocks = (links.find((item) => item.key === "blocks") as LinkType).id;
    expect(
      (await send(admin, "POST", `/api/v1/tickets/${epic.key}/links`, { typeId: blocks, targetKey: combo.key })).status,
    ).toBe(200);
    const current = (await fresh(epic.key)).body;
    const patched = await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${epic.key}`, {
      version: current.version,
      checklist: [{ text: "Камера", done: false, childKey: camera.key }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return { epic, camera, switcher, combo };
  };
  return { type, production, create, fresh, trash, restore, parentsOf, epicWithChildren };
}

describe("trash (R-2.22) and deleting a parent (R-2.8)", () => {
  test("a ticket without children goes to the trash at once and comes back with its links", async () => {
    const { create, fresh, trash, restore } = await kit();
    const epic = await create("Боевая система", "epic");
    const story = await create("Интерфейс боя", "story", admin, { parentKey: epic.key });
    const deleted = await trash(admin, { keys: [story.key] });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.deleted).toEqual([{ key: story.key, title: "Интерфейс боя" }]);

    const gone = await fresh(story.key);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: "ticket_in_trash", ticket: { key: story.key, canRestore: true } });
    expect((await fresh(epic.key)).body.relations.children).toEqual([]);
    const list = (await get<{ items: TicketSummary[] }>(admin, `/api/v1/tickets?spaceId=${epic.spaceId}`)).body.items;
    expect(JSON.stringify(list)).not.toContain(story.key);
    const bin = (await get<{ items: TrashItem[]; settings: TrashSettings }>(admin, "/api/v1/trash")).body;
    expect(bin.items[0]).toMatchObject({ key: story.key, relations: 1, canRestore: true, canPurge: true });
    expect(bin.settings.retentionDays).toBe(90);

    // «Отменить» — восстановление пакета.
    const back = await restore(admin, { batchId: deleted.body.batchId });
    expect(back.body).toEqual({ restored: [{ key: story.key, title: "Интерфейс боя" }], skipped: [] });
    const restored = (await fresh(story.key)).body;
    expect(restored.relations.parents).toMatchObject([{ key: epic.key }]);
    expect(restored.numbers.map((item) => item.number)).toEqual(["1.1"]);
  });

  test("deleting an epic asks about the children; by default they stay without the link, keep a trace; restoring brings everything back", async () => {
    const { fresh, trash, restore, epicWithChildren } = await kit();
    const { epic, camera, switcher, combo } = await epicWithChildren();

    const ask = await trash(admin, { keys: [epic.key] });
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe("children_choice_required");
    expect(ask.body.choice?.children.map((item) => item.key).sort()).toEqual([camera.key, switcher.key].sort());
    expect(ask.body.choice?.hasGrandparents).toBe(false);
    expect((await fresh(epic.key)).status).toBe(200);

    const deleted = await trash(admin, { keys: [epic.key], children: "keep" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.children).toHaveLength(2);
    const child = (await fresh(camera.key)).body;
    expect(child.relations.parents).toEqual([]);
    expect(child.relations.traces).toMatchObject([
      { parentKey: epic.key, parentTitle: "Прототип боя", parentState: "trash", others: 1 },
    ]);
    const history = (
      await get<{ items: { field: string; sourceDetail: string | null; from: { text: string } | null }[] }>(
        admin,
        `/api/v1/tickets/${camera.key}/history`,
      )
    ).body.items;
    expect(history.find((entry) => entry.field === "parents" && entry.sourceDetail === "trash")?.from?.text).toBe(
      `${epic.key} Прототип боя`,
    );
    expect((await fresh(combo.key)).body.relations.links).toEqual([]);

    const back = await restore(admin, { keys: [epic.key] });
    expect(back.body.skipped).toEqual([]);
    const restored = (await fresh(epic.key)).body;
    expect(restored.relations.children.map((item) => (item.available ? item.key : "?")).sort()).toEqual(
      [camera.key, switcher.key].sort(),
    );
    expect(restored.relations.links).toMatchObject([{ typeKey: "blocks", ticket: { key: combo.key } }]);
    expect(restored.checklist[0]?.childKey).toBe(camera.key);
    expect((await fresh(camera.key)).body.relations.traces).toEqual([]);
  });

  test("children go to the parent of the deleted ticket or to a new parent; «Undo» puts them back", async () => {
    const { create, trash, restore, parentsOf, epicWithChildren } = await kit();
    const { epic, camera, switcher } = await epicWithChildren();
    const goal = await create("Боевая система", "goal");
    expect((await send(admin, "POST", `/api/v1/tickets/${epic.key}/parents`, { parentKey: goal.key })).status).toBe(
      200,
    );

    const up = await trash(admin, { keys: [epic.key], children: "grandparent" });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(await parentsOf(camera.key)).toEqual([goal.key]);
    expect((await restore(admin, { batchId: up.body.batchId })).status).toBe(200);
    expect(await parentsOf(camera.key)).toEqual([epic.key]);
    expect(await parentsOf(epic.key)).toEqual([goal.key]);

    const moved = await trash(admin, { keys: [epic.key], children: "relink", newParentTitle: "Прототип боя 2" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const [newParent] = await parentsOf(switcher.key);
    expect(newParent).not.toBe(epic.key);
    expect(await parentsOf(camera.key)).toEqual([newParent]);
    await restore(admin, { batchId: moved.body.batchId });
    expect(await parentsOf(switcher.key)).toEqual([epic.key]);
  });

  test("«delete together» removes the whole branch in one batch; several tickets need a confirmation", async () => {
    const { create, fresh, trash, restore, epicWithChildren } = await kit();
    const { epic, camera, switcher } = await epicWithChildren();
    const grandchild = await create("Тряска камеры", "task", admin, { parentKey: camera.key });

    const unconfirmed = await trash(admin, { keys: [epic.key], children: "delete" });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({ code: "bulk_confirm_required", count: 4 });
    const all = await trash(admin, { keys: [epic.key], children: "delete", confirm: true });
    expect(all.body.deleted).toHaveLength(4);
    for (const key of [camera.key, switcher.key, grandchild.key])
      expect((await fresh(key)).body.code).toBe("ticket_in_trash");

    await restore(admin, { batchId: all.body.batchId });
    expect((await fresh(grandchild.key)).body.relations.parents).toMatchObject([{ key: camera.key }]);
    expect((await fresh(camera.key)).body.relations.parents).toMatchObject([{ key: epic.key }]);
  });

  test("after the clean-up the key and the trace stay; parentTrace() finds the former children; «Relink» binds them in one action", async () => {
    const { create, fresh, trash, epicWithChildren, production } = await kit();
    const { epic, camera, switcher } = await epicWithChildren();
    await trash(admin, { keys: [epic.key], children: "keep" });

    // Досрочная очистка — только суперадмин.
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await send(anna, "POST", "/api/v1/trash/purge", { keys: [epic.key] })).status).toBe(403);
    const purged = await send(admin, "POST", "/api/v1/trash/purge", { keys: [epic.key] });
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    const gone = await fresh(epic.key);
    expect(gone.status).toBe(410);
    expect(gone.body).toMatchObject({ code: "ticket_purged", ticket: { key: epic.key, title: "Прототип боя" } });
    expect((await get<{ items: TrashItem[] }>(admin, "/api/v1/trash")).body.items).toEqual([]);
    expect((await fresh(camera.key)).body.relations.traces).toMatchObject([
      { parentKey: epic.key, parentState: "purged", others: 1 },
    ]);

    const found = (
      await get<{ items: TicketSummary[] }>(
        admin,
        `/api/v1/tickets?spaceId=${production}&q=${encodeURIComponent(`parentTrace(${epic.key.toLowerCase()})`)}`,
      )
    ).body.items;
    expect(found.map((item) => item.key).sort()).toEqual([camera.key, switcher.key].sort());

    // Ключ не выдаётся снова: счётчик только растёт.
    const next = await create("Новый прототип боя", "epic");
    expect(next.number).toBeGreaterThan(epic.number);
    const relinked = await send<RelinkResult>(admin, "POST", "/api/v1/traces/relink", {
      parentKey: epic.key,
      toKey: next.key,
    });
    expect(relinked.body.relinked.map((item) => item.key).sort()).toEqual([camera.key, switcher.key].sort());
    expect((await fresh(next.key)).body.relations.children).toHaveLength(2);
    expect((await fresh(camera.key)).body.relations.traces).toEqual([]);
    // След остаётся навсегда: функция по-прежнему находит бывших детей.
    const still = (
      await get<{ items: TicketSummary[] }>(admin, `/api/v1/tickets?spaceId=${production}&q=parentTrace(${epic.key})`)
    ).body.items;
    expect(still).toHaveLength(2);
  });

  test("the system rule cleans what stayed longer than the period; the period is set by a superadmin", async () => {
    const { create, fresh, trash } = await kit();
    const old = await create("Старьё");
    await trash(admin, { keys: [old.key] });
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await send(anna, "PUT", "/api/v1/trash-settings", { retentionDays: 1 })).status).toBe(403);
    const changed = await send<TrashSettings>(admin, "PUT", "/api/v1/trash-settings", { retentionDays: 1 });
    expect(changed.body.retentionDays).toBe(1);
    expect(await app.trash.purgeExpired(Date.now() + 12 * 60 * 60 * 1000)).toBe(0);
    expect(await app.trash.purgeExpired(Date.now() + 2 * 24 * 60 * 60 * 1000)).toBe(1);
    expect((await fresh(old.key)).body.code).toBe("ticket_purged");
    expect((await send(admin, "POST", "/api/v1/trash/restore", { keys: [old.key] })).status).toBe(410);
  });
});

describe("rights to delete and restore (R-5.2)", () => {
  /** pm — кто ПМ Жаб: Анна или никто (тогда Анна — просто участник). */
  async function world(pm: "anna" | null) {
    const base = await kit();
    const people = (await get<{ items: Person[] }>(admin, "/api/v1/people")).body.items;
    const person = (login: string) => people.find((item) => item.catalog?.username === login) as Person;
    const anna = (await signIn(app, { login: "anna" })).user;
    const ben = (await signIn(app, { login: "ben" })).user;
    const toads = (
      await send<FeatureTeam>(admin, "POST", "/api/v1/feature-teams", {
        name: "Жабы",
        ...(pm ? { pmId: person(pm).id } : {}),
        memberIds: [person("anna").id],
      })
    ).body;
    const gd = (
      await send<Guild>(admin, "POST", "/api/v1/guilds", {
        name: "ГД",
        leadId: person("ben").id,
        memberIds: [person("ben").id],
      })
    ).body;
    const teamTicket = async (title: string, user = admin) => {
      const created = await base.create(title, "task", user);
      const patched = await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${created.key}`, {
        version: created.version,
        values: { team: toads.id, stream: [gd.id] },
      });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      return patched.body;
    };
    const inWork = async (ticket: Ticket) => {
      const scheme = (
        await get<StatusScheme>(admin, `/api/v1/ticket-types/${ticket.typeId}/scheme?spaceId=${ticket.spaceId}`)
      ).body;
      const status = scheme.statuses.find((item) => item.category === "in_progress" && !item.waiting) as WorkflowStatus;
      const moved = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
        version: ticket.version,
        statusId: status.id,
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      return moved.body;
    };
    return { ...base, anna, ben, teamTicket, inWork };
  }

  test("a member does not delete someone else's ticket in work, nor restores what others deleted; deletes and restores their own queued one", async () => {
    const { anna, teamTicket, inWork, trash, restore, create } = await world(null);
    const foreign = await inWork(await teamTicket("Переключение персонажа в бою"));
    const refused = await trash(anna, { keys: [foreign.key] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("forbidden");
    expect((await anna.request("GET", `/api/v1/tickets/${foreign.key}`)).json().permissions.trash).toBe(false);

    await trash(admin, { keys: [foreign.key] });
    const notMine = await restore(anna, { keys: [foreign.key] });
    expect(notMine.status).toBe(403);
    expect(notMine.body.detail).toContain("Only the person who deleted it");

    const own = await create("Мой черновик", "story", anna);
    expect((await trash(anna, { keys: [own.key] })).status).toBe(200);
    expect((await restore(anna, { keys: [own.key] })).status).toBe(200);
  });

  test("a lead deletes tickets of their stream; the team PM gets one notification for the batch and can restore them", async () => {
    const { ben, anna, teamTicket, inWork, trash, restore } = await world("anna");
    const first = await inWork(await teamTicket("Камера дёргается"));
    const second = await teamTicket("Звук смены героя");
    const deleted = await trash(ben, { keys: [first.key, second.key], confirm: true });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.notified.map((item) => item.name)).toEqual(["Анна Тестова"]);

    const bell = (await get<{ items: AppNotification[]; unread: number }>(anna, "/api/v1/notifications")).body;
    expect(bell.unread).toBe(1);
    expect(bell.items[0]).toMatchObject({ kind: "team_ticket_trashed", batchId: deleted.body.batchId });
    expect(bell.items[0]?.tickets.map((item) => item.key).sort()).toEqual([first.key, second.key].sort());
    expect((await send(anna, "POST", "/api/v1/notifications/read", {})).status).toBe(204);
    expect((await get<{ unread: number }>(anna, "/api/v1/notifications")).body.unread).toBe(0);

    const items = (await get<{ items: TrashItem[] }>(anna, "/api/v1/trash")).body.items;
    expect(items.map((item) => [item.canRestore, item.canPurge])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect((await restore(anna, { keys: [first.key] })).status).toBe(200);
    expect((await restore(ben, { keys: [second.key] })).status).toBe(200);
  });
});
