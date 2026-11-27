import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Space, StatusScheme, Ticket, TicketSummary, TicketType, WorkflowStatus } from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-05 (схемы статусов) и YT-06 (тикет) через API. */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

type Body<T> = T & {
  code?: string;
  errors?: { field: string; message: string }[];
  current?: Ticket;
  candidates?: string[];
};
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => (await user.request("GET", url)).json() as T;

async function setup() {
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).items;
  const type = (key: string) => types.find((item) => item.key === key) as TicketType;
  const spaces = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).items;
  const space = (slug: string) => spaces.find((item) => item.slug === slug) as Space;
  const scheme = (key: string, spaceId?: string) =>
    get<StatusScheme>(admin, `/api/v1/ticket-types/${type(key).id}/scheme${spaceId ? `?spaceId=${spaceId}` : ""}`);
  return { type, space, scheme };
}
const byName = (scheme: StatusScheme, name: string) =>
  scheme.statuses.find((status) => status.name === name) as WorkflowStatus;

describe("status schemes (YT-05)", () => {
  test("start schemes of story, bug, task, epic, goal and request follow R-5.1", async () => {
    const { scheme } = await setup();
    const story = await scheme("story");
    expect(story.statuses.map((status) => status.name)).toEqual([
      "Backlog",
      "Discovery",
      "Discovery Done",
      "To Do",
      "Analysis",
      "Analysis Done",
      "Design",
      "Design Done",
      "Creation",
      "Creation Done",
      "Implementation",
      "Implementation Done",
      "Test",
      "Done",
    ]);
    expect(story.statuses.filter((status) => status.waiting).map((status) => status.name)).toEqual([
      "Discovery Done",
      "Analysis Done",
      "Design Done",
      "Creation Done",
      "Implementation Done",
    ]);
    expect(byName(story, "To Do")).toMatchObject({ category: "queue", responsibleRoles: ["assignees"] });
    expect(byName(story, "Discovery Done")).toMatchObject({
      category: "in_progress",
      freezeRequirements: true,
      responsibleRoles: ["pm"],
    });
    expect(byName(story, "Done")).toMatchObject({ category: "done", outcomes: ["done", "cancelled"] });
    expect((await scheme("bug")).statuses.map((status) => status.name)).toEqual([
      "Backlog",
      "Discovery",
      "Discovery Done",
      "To Do",
      "Implementation",
      "Implementation Done",
      "Test",
      "Done",
    ]);
    expect(byName(await scheme("bug"), "Done").outcomes).toEqual(["fixed", "wont_fix", "duplicate", "cancelled"]);
    for (const key of ["task", "request"]) {
      expect((await scheme(key)).statuses.map((status) => status.name)).toEqual([
        "Backlog",
        "To Do",
        "Creation",
        "Done",
      ]);
    }
    for (const key of ["epic", "goal"]) {
      expect((await scheme(key)).statuses.map((status) => status.name)).toEqual(["Backlog", "In Progress", "Done"]);
    }
  });

  test("admin adds a waiting status and a required field on entry to To Do", async () => {
    const { type, scheme } = await setup();
    const story = await scheme("story");
    const statuses = story.statuses.flatMap((status) =>
      status.name === "To Do"
        ? [
            { ...status, requirements: [...status.requirements, { kind: "field", fieldKey: "stream" }] },
            {
              name: "Ready for Art",
              category: "queue",
              waiting: true,
              outcomes: [],
              requirements: [],
              responsibleRoles: ["gd"],
              freezeRequirements: false,
            },
          ]
        : [status],
    );
    const saved = await send<StatusScheme>(admin, "PUT", `/api/v1/ticket-types/${type("story").id}/scheme`, {
      strictOrder: false,
      statuses,
    });
    expect(saved.status).toBe(200);
    expect(byName(saved.body, "Ready for Art")).toMatchObject({ category: "queue", waiting: true });
    expect(byName(saved.body, "To Do").requirements).toContainEqual({ kind: "field", fieldKey: "stream" });
    expect(byName(saved.body, "To Do").id).toBe(byName(story, "To Do").id);
  });

  test("a status without a category or a done status without an outcome cannot be saved", async () => {
    const { type, scheme } = await setup();
    const story = await scheme("story");
    const noCategory = story.statuses.map((status, index) =>
      index === 1 ? { ...status, category: undefined } : status,
    );
    let response = await send(admin, "PUT", `/api/v1/ticket-types/${type("story").id}/scheme`, {
      strictOrder: false,
      statuses: noCategory,
    });
    expect(response.body.code).toBe("validation_failed");
    expect(response.body.errors?.[0]?.field).toBe("statuses/1/category");

    const noOutcome = [
      ...story.statuses.slice(0, -1),
      {
        name: "Released",
        category: "done",
        waiting: false,
        outcomes: [],
        requirements: [],
        responsibleRoles: [],
        freezeRequirements: false,
      },
      story.statuses.at(-1),
    ];
    response = await send(admin, "PUT", `/api/v1/ticket-types/${type("story").id}/scheme`, {
      strictOrder: false,
      statuses: noOutcome,
    });
    expect(response.body.errors).toContainEqual({
      field: "statuses/13/outcomes",
      message: "a done status needs at least one outcome",
    });

    const unknownField = story.statuses.map((status) =>
      status.name === "To Do" ? { ...status, requirements: [{ kind: "field", fieldKey: "severity" }] } : status,
    );
    response = await send(admin, "PUT", `/api/v1/ticket-types/${type("story").id}/scheme`, {
      strictOrder: false,
      statuses: unknownField,
    });
    expect(JSON.stringify(response.body.errors)).toContain('no field \\"severity\\"');
  });

  test("a space can have its own scheme; its tickets move by status name and back on reset", async () => {
    const { type, space, scheme } = await setup();
    const core = space("core");
    const ticket = (
      await send<Ticket>(admin, "POST", "/api/v1/tickets", { spaceId: core.id, typeId: type("task").id, title: "Т" })
    ).body;
    let own = await scheme("task", core.id);
    expect(own.inherited).toBe(true);
    const saved = await send<StatusScheme>(admin, "PUT", `/api/v1/ticket-types/${type("task").id}/scheme`, {
      spaceId: core.id,
      strictOrder: true,
      statuses: own.statuses.map((status) => ({ ...status, id: undefined })),
    });
    expect(saved.body).toMatchObject({ inherited: false, strictOrder: true });
    const moved = await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`);
    expect(moved.statusId).toBe(byName(saved.body, "Backlog").id);
    expect(moved.statusId).not.toBe(ticket.statusId);
    // Схема по умолчанию не тронута.
    expect((await scheme("task")).strictOrder).toBe(false);

    own = (
      await send<StatusScheme>(admin, "DELETE", `/api/v1/ticket-types/${type("task").id}/scheme?spaceId=${core.id}`)
    ).body;
    expect(own.inherited).toBe(true);
    expect((await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).statusId).toBe(ticket.statusId);
  });

  test("outcomes are set per type; «cancelled» stays; used outcomes cannot be removed", async () => {
    const { type } = await setup();
    expect(type("bug").outcomes.map((outcome) => outcome.key)).toEqual(["fixed", "wont_fix", "duplicate", "cancelled"]);
    const bad = await send(admin, "PATCH", `/api/v1/ticket-types/${type("task").id}`, {
      outcomes: [{ key: "done", label: "Готово" }],
    });
    expect(bad.body.code).toBe("validation_failed");
    const used = await send(admin, "PATCH", `/api/v1/ticket-types/${type("bug").id}`, {
      outcomes: [
        { key: "fixed", label: "Исправлено" },
        { key: "cancelled", label: "Отменено" },
      ],
    });
    expect(used.body.code).toBe("conflict");
    const added = await send<TicketType>(admin, "PATCH", `/api/v1/ticket-types/${type("task").id}`, {
      outcomes: [...type("task").outcomes, { key: "moved", label: "Перенесено" }],
    });
    expect(added.body.outcomes.map((outcome) => outcome.key)).toEqual(["done", "cancelled", "moved"]);

    const created = await send<TicketType>(admin, "POST", "/api/v1/ticket-types", {
      name: "Веха",
      color: "#000000",
      icon: "flag",
    });
    const milestone = await get<StatusScheme>(admin, `/api/v1/ticket-types/${created.body.id}/scheme`);
    expect(milestone.statuses.map((status) => [status.name, status.category])).toEqual([
      ["Backlog", "queue"],
      ["In Progress", "in_progress"],
      ["Done", "done"],
    ]);
  });
});

describe("tickets (YT-06)", () => {
  async function story(title = "Стори про жабу") {
    const { type, space } = await setup();
    const created = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: space("core").id,
      typeId: type("story").id,
      title,
      templateId: "template-story",
    });
    expect(created.status).toBe(201);
    return created.body;
  }

  test("created from a template: structure, checklist and first status; keys go in a row and are never reused", async () => {
    const { type, space, scheme } = await setup();
    const first = await story();
    expect(first.key).toMatch(/^AOS-\d+$/);
    expect(first.description).toContain("## Критерии приёмки");
    expect(first.checklist.map((item) => item.text)).toEqual([
      "Документы по ссылкам прочитаны",
      "Критерии приёмки проверены",
      "Техдока и инструкция обновлены",
    ]);
    expect(first.statusId).toBe((await scheme("story")).statuses[0]?.id);
    expect(first).toMatchObject({
      priority: "normal",
      version: 1,
      archived: null,
      createdBy: { name: "Суперадмин Тестовый" },
    });

    // Быстрое создание одной строкой (название + тип), в другом пространстве — счётчик общий.
    const quick = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: space("production").id,
      typeId: type("task").id,
      title: "Быстро",
    });
    const failed = await send(admin, "POST", "/api/v1/tickets", {
      spaceId: space("core").id,
      typeId: "nope",
      title: "Ошибка",
    });
    expect(failed.status).toBe(404);
    const third = await story("Третья");
    expect([first.number + 1, first.number + 2]).toEqual([quick.body.number, third.number]);
    expect(quick.body.description).toBe("");
    // Отменённый и архивный тикет номер не освобождают.
    await send(admin, "POST", `/api/v1/tickets/${third.key}/cancel`, { version: third.version, reason: "Дубль" });
    expect((await story("Четвёртая")).number).toBe(third.number + 1);

    const list = (await get<{ items: TicketSummary[] }>(admin, `/api/v1/tickets?spaceId=${space("core").id}`)).items;
    expect(list.map((item) => item.key)).toEqual([`AOS-${third.number + 1}`, third.key, first.key]);
  });

  test("every field is saved and comes back; dates, blocked flag, tags, people in several roles", async () => {
    const ticket = await story();
    const people = (await get<{ items: { id: string; name: string }[] }>(admin, "/api/v1/people")).items;
    const anna = people.find((person) => person.name === "Анна Тестова")?.id as string;
    const ben = people.find((person) => person.name === "Ben Tester")?.id as string;
    const teams = (await get<{ items: { id: string }[] }>(admin, "/api/v1/feature-teams")).items;
    const saved = await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: ticket.version,
      title: "Жаба прыгает",
      description: "## Задача\nПрыжок <script>alert(1)</script>",
      checklist: [...ticket.checklist.map((item) => ({ ...item, done: true })), { text: "Свой пункт", done: false }],
      values: { size: "scale-tshirt-m", estimate_days: 6, team: teams[0]?.id, due_date: "2026-12-20" },
      priority: "high",
      tags: ["арт", "Арт", " звук "],
      startDate: "2026-12-01",
      endDate: "2026-11-20",
      blocked: true,
      blockedReason: "Ждём референсы",
      people: { assigneeIds: [anna, ben], customerId: ben, testerId: anna, watcherIds: [ben] },
    });
    expect(saved.status).toBe(200);
    const reloaded = await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`);
    expect(reloaded).toMatchObject({
      title: "Жаба прыгает",
      description: "## Задача\nПрыжок <script>alert(1)</script>",
      values: { size: "scale-tshirt-m", estimate_days: 6, due_date: "2026-12-20" },
      priority: "high",
      tags: ["арт", "звук"],
      startDate: "2026-12-01",
      endDate: "2026-11-20",
      blocked: true,
      blockedReason: "Ждём референсы",
      version: 2,
    });
    expect(reloaded.people.assignees.map((person) => person.name)).toEqual(["Анна Тестова", "Ben Tester"]);
    expect(reloaded.people.customer?.name).toBe("Ben Tester");
    expect(reloaded.people.tester?.name).toBe("Анна Тестова");
    expect(reloaded.people.watchers.map((person) => person.name)).toEqual(["Ben Tester"]);
    expect(reloaded.checklist.at(-1)).toMatchObject({ text: "Свой пункт", done: false });

    const noReason = await send(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: 2,
      blocked: true,
      blockedReason: " ",
    });
    expect(noReason.body.errors?.[0]?.field).toBe("blockedReason");
    const badValue = await send(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: 2,
      values: { size: "XXL" },
    });
    expect(badValue.body.errors?.[0]?.field).toBe("values/size");
  });

  test("a required field left empty blocks the move with a clear error", async () => {
    const { scheme } = await setup();
    const ticket = await story();
    const toDo = byName(await scheme("story"), "To Do");
    const blocked = await send(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
      version: ticket.version,
      statusId: toDo.id,
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe("transition_blocked");
    expect(blocked.body.errors?.map((error) => error.message)).toEqual([
      "fill in the field: Размер",
      "assign: assignees",
      "fill in the field: Оценка в днях",
      "fill in the field: Срок",
    ]);
    const me = await get<{ user: { id: string } }>(admin, "/api/v1/me");
    let current = (
      await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/assign-me`, { version: ticket.version })
    ).body;
    expect(current.people.assignees.map((person) => person.id)).toEqual([me.user.id]);
    current = (
      await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, {
        version: current.version,
        values: { size: "scale-tshirt-m", estimate_days: 6, due_date: "2026-12-20" },
      })
    ).body;
    const moved = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
      version: current.version,
      statusId: toDo.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.statusId).toBe(toDo.id);

    // В Done — с исходом, а «отменено» — только через отмену.
    const done = byName(await scheme("story"), "Done");
    const noOutcome = await send(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
      version: moved.body.version,
      statusId: done.id,
    });
    expect(noOutcome.body.errors?.[0]?.field).toBe("outcome");
    const checklistOpen = await send(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
      version: moved.body.version,
      statusId: done.id,
      outcome: "done",
    });
    expect(checklistOpen.body.errors?.map((error) => error.field)).toEqual(["checklist_done"]);
  });

  test("cancelling gives the outcome «cancelled» with a reason; archive hides the ticket and returns it with its status", async () => {
    const { space, scheme } = await setup();
    const ticket = await story();
    expect(
      (await send(admin, "POST", `/api/v1/tickets/${ticket.key}/cancel`, { version: 1, reason: "  " })).body.errors?.[0]
        ?.field,
    ).toBe("reason");
    const cancelled = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/cancel`, {
      version: 1,
      reason: "Фичу убрали из плана",
    });
    expect(cancelled.body).toMatchObject({
      outcome: "cancelled",
      cancelReason: "Фичу убрали из плана",
      statusId: byName(await scheme("story"), "Done").id,
    });

    const other = await story("В архив");
    const archived = await send<Ticket>(admin, "POST", `/api/v1/tickets/${other.key}/archive`, {
      version: 1,
      reason: "postponed",
    });
    expect(archived.body.archived?.reason).toBe("postponed");
    const visible = async (archivedMode = "exclude") =>
      (
        await get<{ items: TicketSummary[] }>(
          admin,
          `/api/v1/tickets?spaceId=${space("core").id}&archived=${archivedMode}`,
        )
      ).items.map((item) => item.key);
    expect(await visible()).not.toContain(other.key);
    expect(await visible("only")).toEqual([other.key]);
    const back = await send<Ticket>(admin, "POST", `/api/v1/tickets/${other.key}/unarchive`, {
      version: archived.body.version,
    });
    expect(back.body).toMatchObject({ archived: null, statusId: other.statusId });
    expect(await visible()).toContain(other.key);
  });

  test("two parallel edits do not silently lose data", async () => {
    const ticket = await story();
    const pm = admin;
    const first = await send<Ticket>(pm, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: ticket.version,
      title: "Правка ПМа",
    });
    expect(first.status).toBe(200);
    const second = await send(pm, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: ticket.version,
      description: "Правка исполнителя",
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("version_conflict");
    expect(second.body.current).toMatchObject({ title: "Правка ПМа", version: 2 });
    expect((await get<Ticket>(pm, `/api/v1/tickets/${ticket.key}`)).description).toContain("## Задача");
  });

  test("type change moves the status by name, by category, or asks", async () => {
    const { type, scheme } = await setup();
    const ticket = await story();
    // Backlog есть и у бага — по имени.
    let changed = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/change-type`, {
      version: 1,
      typeId: type("bug").id,
    });
    expect(changed.body.statusId).toBe(byName(await scheme("bug"), "Backlog").id);
    // Creation есть у задачи; у эпика нет — две «в работе» нет, одна In Progress — по категории.
    const task = await scheme("task");
    changed = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/change-type`, {
      version: changed.body.version,
      typeId: type("task").id,
    });
    changed = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/transition`, {
      version: changed.body.version,
      statusId: byName(task, "Creation").id,
    });
    const toEpic = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/change-type`, {
      version: changed.body.version,
      typeId: type("epic").id,
    });
    expect(toEpic.body.statusId).toBe(byName(await scheme("epic"), "In Progress").id);
    // Из эпика в баг: «In Progress» — несколько статусов «в работе» → вопрос.
    const ask = await send(admin, "POST", `/api/v1/tickets/${ticket.key}/change-type`, {
      version: toEpic.body.version,
      typeId: type("bug").id,
    });
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe("status_choice_required");
    expect(ask.body.candidates).toHaveLength(5);
    const chosen = await send<Ticket>(admin, "POST", `/api/v1/tickets/${ticket.key}/change-type`, {
      version: toEpic.body.version,
      typeId: type("bug").id,
      statusId: ask.body.candidates?.[0],
    });
    expect(chosen.body).toMatchObject({ typeId: type("bug").id, statusId: ask.body.candidates?.[0] });
  });

  test("tickets are visible only in visible spaces; strict order is enforced", async () => {
    const { type, space } = await setup();
    const ticket = await story();
    const vera = (await signIn(app, { login: "vera" })).user;
    expect((await vera.request("GET", `/api/v1/tickets/${ticket.key}`)).statusCode).toBe(404);

    const task = await get<StatusScheme>(admin, `/api/v1/ticket-types/${type("task").id}/scheme`);
    await send(admin, "PUT", `/api/v1/ticket-types/${type("task").id}/scheme`, {
      strictOrder: true,
      statuses: task.statuses,
    });
    const quick = (
      await send<Ticket>(admin, "POST", "/api/v1/tickets", {
        spaceId: space("core").id,
        typeId: type("task").id,
        title: "Строго",
      })
    ).body;
    const jump = await send(admin, "POST", `/api/v1/tickets/${quick.key}/transition`, {
      version: 1,
      statusId: byName(task, "Creation").id,
    });
    expect(jump.body.code).toBe("transition_blocked");
    const next = await send(admin, "POST", `/api/v1/tickets/${quick.key}/transition`, {
      version: 1,
      statusId: byName(task, "To Do").id,
    });
    expect(next.status).toBe(200);
  });
});
