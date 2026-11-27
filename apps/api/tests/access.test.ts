import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AccessGrant,
  AccessProfile,
  FeatureTeam,
  Guild,
  Me,
  Person,
  Space,
  Ticket,
  TicketSummary,
  TicketType,
  TitleOnlyTicket,
} from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-08: права «кто × где × что», видимость, маска полей, «Смотреть как» и «Режим показа» через API. */
let app: FastifyInstance;
let admin: Client;
let anna: Client;
let ben: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
  anna = (await signIn(app, { login: "anna" })).user;
  ben = (await signIn(app, { login: "ben" })).user;
});

type Body<T> = T & { code?: string; detail?: string; ticket?: TitleOnlyTicket; errors?: { field: string }[] };
async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => {
  const response = await user.request("GET", url);
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
};

/** Сценарий карточки: Анна — участник Жаб; Бен — лид колодца ГД; Хрюшки — чужая для обоих команда. */
async function world() {
  const people = (await get<{ items: Person[] }>(admin, "/api/v1/people")).body.items;
  const person = (login: string) => people.find((item) => item.catalog?.username === login) as Person;
  const toads = (
    await send<FeatureTeam>(admin, "POST", "/api/v1/feature-teams", { name: "Жабы", memberIds: [person("anna").id] })
  ).body;
  const pigs = (await send<FeatureTeam>(admin, "POST", "/api/v1/feature-teams", { name: "Хрюшки" })).body;
  const gd = (
    await send<Guild>(admin, "POST", "/api/v1/guilds", {
      name: "ГД",
      leadId: person("ben").id,
      memberIds: [person("ben").id],
    })
  ).body;
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).body.items;
  const type = (key: string) => (types.find((item) => item.key === key) as TicketType).id;
  const spaces = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).body.items;
  const space = (slug: string) => (spaces.find((item) => item.slug === slug) as Space).id;
  const create = async (
    user: Client,
    title: string,
    values: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => {
    const created = await send<Ticket>(user, "POST", "/api/v1/tickets", {
      spaceId: space("production"),
      typeId: type("story"),
      title,
      ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (!Object.keys(values).length) return created.body;
    return (
      await send<Ticket>(admin, "PATCH", `/api/v1/tickets/${created.body.key}`, {
        version: created.body.version,
        values,
      })
    ).body;
  };
  return { person, toads, pigs, gd, type, space, create };
}

describe("rights «who × where × what» (R-2.20, R-5.2)", () => {
  test("a Toads member edits a Toads ticket but neither changes visibility nor deletes someone else's ticket in work", async () => {
    const { toads, create } = await world();
    const ticket = await create(admin, "Переключение персонажа в бою", { team: toads.id });
    expect(ticket.permissions).toMatchObject({ edit: true, visibility: true, trash: true });

    const seen = await get<Ticket>(anna, `/api/v1/tickets/${ticket.key}`);
    expect(seen.body.permissions).toMatchObject({
      edit: true,
      status: true,
      assign: true,
      visibility: false,
      trash: false,
    });
    const edited = await send<Ticket>(anna, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: seen.body.version,
      description: "Без паузы",
    });
    expect(edited.status).toBe(200);
    const hide = await send(anna, "PUT", `/api/v1/tickets/${ticket.key}/visibility`, {
      version: edited.body.version,
      visibility: "hidden",
    });
    expect(hide.status).toBe(403);
    expect(hide.body.code).toBe("forbidden");

    // Свой тикет, пока он в очереди, участник удалить может (R-5.2); в работе — уже нет.
    const own = await create(anna, "Мой черновик");
    expect(own.permissions.trash).toBe(true);
    // Тикет чужой команды участник видит, но не правит.
    const foreign = await create(admin, "Чужое", {});
    const attempt = await send(anna, "PATCH", `/api/v1/tickets/${foreign.key}`, {
      version: foreign.version,
      title: "x",
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.detail).toContain("team");
  });

  test("the GD lead edits the description of a GD ticket in the Pigs team but cannot change its assignee", async () => {
    const { pigs, gd, create, person } = await world();
    const ticket = await create(admin, "Сценарий боя", { team: pigs.id, stream: [gd.id] });
    const seen = (await get<Ticket>(ben, `/api/v1/tickets/${ticket.key}`)).body;
    expect(seen.permissions).toMatchObject({ edit: true, assign: false, status: false, dates: false });
    const edited = await send<Ticket>(ben, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: seen.version,
      description: "Правка лида ГД",
    });
    expect(edited.status).toBe(200);
    const assign = await send(ben, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: edited.body.version,
      people: { assigneeIds: [person("ben").id] },
    });
    expect(assign.status).toBe(403);
    // Форма свойств целиком (люди не менялись): право нужно только на то, что меняется.
    const whole = await send<Ticket>(ben, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: edited.body.version,
      priority: "high",
      people: { assigneeIds: [], customerId: null, testerId: null, watcherIds: [] },
      startDate: null,
      endDate: null,
    });
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(whole.body.priority).toBe("high");

    // Без фичекоманды лид колодца имеет права ПМа (R-5.2).
    const noTeam = await create(admin, "Реквест колодца", { stream: [gd.id] });
    expect((await get<Ticket>(ben, `/api/v1/tickets/${noTeam.key}`)).body.permissions).toMatchObject({
      assign: true,
      status: true,
      dates: true,
    });
  });

  test("a new guild lead in the directory gets the rights at once; the old lead loses them", async () => {
    const { pigs, gd, create, person } = await world();
    const ticket = await create(admin, "Сценарий боя", { team: pigs.id, stream: [gd.id] });
    expect((await get<Ticket>(ben, `/api/v1/tickets/${ticket.key}`)).body.permissions.edit).toBe(true);
    expect((await get<Ticket>(anna, `/api/v1/tickets/${ticket.key}`)).body.permissions.edit).toBe(false);

    const changed = await send<Guild>(admin, "PATCH", `/api/v1/guilds/${gd.id}`, { leadId: person("anna").id });
    expect(changed.status).toBe(200);
    // Бен остался в колодце, но как участник стрима права лида не имеет.
    expect((await get<Ticket>(ben, `/api/v1/tickets/${ticket.key}`)).body.permissions.edit).toBe(false);
    expect((await get<Ticket>(anna, `/api/v1/tickets/${ticket.key}`)).body.permissions.edit).toBe(true);
  });

  test("a profile built in the constructor and granted on a branch works there and only there", async () => {
    const { create } = await world();
    const epic = await create(admin, "Боевая система");
    const story = await create(admin, "Комбо", {}, { parentKey: epic.key });
    const outside = await create(admin, "Вне ветки");

    const reviewer = await send<AccessProfile>(admin, "POST", "/api/v1/access/profiles", {
      name: "Ревьюер ветки",
      rights: { view: ["all"], comment: ["all"], edit: ["all"], status: ["all"], assign: [] },
    });
    expect(reviewer.status).toBe(201);
    expect(reviewer.body.rights).toEqual({ view: ["all"], comment: ["all"], edit: ["all"], status: ["all"] });
    const benId = (await get<Me>(ben, "/api/v1/me")).body.user.id;
    const grant = await send<AccessGrant>(admin, "POST", "/api/v1/access/grants", {
      subject: { kind: "person", id: benId },
      place: { spaceId: null, branchKey: epic.key, fieldKey: null, fieldValue: null },
      profileId: reviewer.body.id,
    });
    expect(grant.status).toBe(201);
    expect(grant.body.place).toMatchObject({ branchKey: epic.key, branchTitle: "Боевая система", spaceName: null });

    const inBranch = (await get<Ticket>(ben, `/api/v1/tickets/${story.key}`)).body;
    expect(inBranch.permissions).toMatchObject({ edit: true, status: true, assign: false });
    expect(
      (
        await send(ben, "PATCH", `/api/v1/tickets/${story.key}`, {
          version: inBranch.version,
          title: "Комбо при смене",
        })
      ).status,
    ).toBe(200);
    expect((await get<Ticket>(ben, `/api/v1/tickets/${outside.key}`)).body.permissions.edit).toBe(false);

    // Профиль с выдачами не удаляется; выдачу забирают — права пропадают.
    expect((await send(admin, "DELETE", `/api/v1/access/profiles/${reviewer.body.id}`)).status).toBe(409);
    expect((await send(admin, "DELETE", `/api/v1/access/grants/${grant.body.id}`)).status).toBe(204);
    expect((await get<Ticket>(ben, `/api/v1/tickets/${story.key}`)).body.permissions.edit).toBe(false);
  });

  test("only a superadmin builds profiles; members cannot grant", async () => {
    await world();
    expect(
      (await send(anna, "POST", "/api/v1/access/profiles", { name: "Я всё могу", rights: { edit: ["all"] } })).status,
    ).toBe(403);
    expect(
      (
        await send(anna, "POST", "/api/v1/access/grants", {
          subject: { kind: "everyone", id: null },
          place: { spaceId: "space-production", branchKey: null, fieldKey: null, fieldValue: null },
          profileId: "profile-space-admin",
        })
      ).status,
    ).toBe(403);
    // В песочнице Анна — админ пространства: там выдавать может.
    const test = (await get<{ items: Space[] }>(anna, "/api/v1/spaces")).body.items.find(
      (space) => space.slug === "test",
    ) as Space;
    expect(test.rights).toContain("grant");
    expect((await get(anna, `/api/v1/access/grants?spaceId=${test.id}`)).status).toBe(200);
  });
});

describe("visibility (R-2.20)", () => {
  test("title only: an outsider sees the epic's title, the API refuses its content, children are not listed", async () => {
    const { create, person, type } = await world();
    const epic = await create(admin, "Секретный эпик", {}, { typeId: type("epic") });
    const story = await create(admin, "Сцена с боссом", {}, { parentKey: epic.key });
    const set = await send<Ticket>(admin, "PUT", `/api/v1/tickets/${epic.key}/visibility`, {
      version: epic.version,
      visibility: "title_only",
      allow: [{ kind: "person", id: person("ben").id }],
    });
    expect(set.status).toBe(200);
    expect(set.body.visibility).toMatchObject({ own: "title_only", effective: "title_only" });
    expect(set.body.visibility.allow.map((entry) => entry.name)).toEqual(["Ben Tester"]);

    const list = (await get<{ items: TicketSummary[] }>(anna, "/api/v1/tickets?spaceId=space-production")).body.items;
    const row = list.find((item) => item.key === epic.key) as TicketSummary;
    expect(row).toMatchObject({ title: "Секретный эпик", titleOnly: true, assignees: [], statusId: "" });
    expect(list.some((item) => item.key === story.key)).toBe(false);

    const content = await get(anna, `/api/v1/tickets/${epic.key}`);
    expect(content.status).toBe(403);
    expect(content.body.code).toBe("ticket_title_only");
    expect(content.body.ticket).toMatchObject({ key: epic.key, title: "Секретный эпик" });
    expect((await get(anna, `/api/v1/tickets/${epic.key}/history`)).status).toBe(403);
    expect((await get(anna, `/api/v1/tickets/${epic.key}/comments`)).status).toBe(403);
    expect((await get(anna, `/api/v1/tickets/${story.key}`)).status).toBe(404);

    // Допущенный по списку видит всё; ребёнок наследует ограничение.
    expect((await get(ben, `/api/v1/tickets/${epic.key}`)).status).toBe(200);
    const child = (await get<Ticket>(ben, `/api/v1/tickets/${story.key}`)).body;
    expect(child.visibility).toMatchObject({ own: null, effective: "hidden", inheritedFrom: epic.key });
  });

  test("an explicit visibility of a child is not overwritten by the parent's change", async () => {
    const { create, type } = await world();
    const epic = await create(admin, "Эпик", {}, { typeId: type("epic") });
    const story = await create(admin, "Открытая стори", {}, { parentKey: epic.key });
    await send(admin, "PUT", `/api/v1/tickets/${story.key}/visibility`, { version: story.version, visibility: "open" });
    const current = (await get<Ticket>(admin, `/api/v1/tickets/${epic.key}`)).body;
    await send(admin, "PUT", `/api/v1/tickets/${epic.key}/visibility`, {
      version: current.version,
      visibility: "hidden",
    });
    expect((await get(anna, `/api/v1/tickets/${epic.key}`)).status).toBe(404);
    expect((await get(anna, `/api/v1/tickets/${story.key}`)).status).toBe(200);
    // Родитель, скрытый от Анны, в карточке ребёнка — строка без ключа и названия (R-2.17).
    expect((await get<Ticket>(anna, `/api/v1/tickets/${story.key}`)).body.relations.parents).toEqual([
      { available: false },
    ]);
  });
});

describe("field mask (R-2.20)", () => {
  test("a field hidden from the member profile is absent for members everywhere, the superadmin sees it", async () => {
    const { create, toads } = await world();
    const fields = (await get<{ items: { id: string; key: string }[] }>(admin, "/api/v1/fields")).body.items;
    const size =
      fields.find((field) => field.key === "estimate_days") ?? fields.find((field) => field.key.includes("estimate"));
    expect(size).toBeTruthy();
    const ticket = await create(admin, "Оценённая", { team: toads.id, [size?.key as string]: 5 });
    expect(ticket.values[size?.key as string]).toBe(5);
    expect(
      (await send(admin, "PUT", `/api/v1/access/masks/${size?.id}`, { profileIds: ["profile-member"] })).status,
    ).toBe(204);

    const seen = (await get<Ticket>(anna, `/api/v1/tickets/${ticket.key}`)).body;
    expect(seen.values[size?.key as string]).toBeUndefined();
    expect(
      (await get<{ items: { field: string }[] }>(anna, `/api/v1/tickets/${ticket.key}/history`)).body.items.some(
        (entry) => entry.field === `values.${size?.key}`,
      ),
    ).toBe(false);
    const write = await send(anna, "PATCH", `/api/v1/tickets/${ticket.key}`, {
      version: seen.version,
      values: { [size?.key as string]: 1 },
    });
    expect(write.status).toBe(403);
    expect((await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).body.values[size?.key as string]).toBe(5);
  });
});

describe("export is a separate right (R-2.20)", () => {
  test("a member cannot export the status sequence; a superadmin can, and the export is logged", async () => {
    const { create, toads } = await world();
    const ticket = await create(admin, "Выгрузка", { team: toads.id });
    expect((await get(anna, `/api/v1/tickets/${ticket.key}/status-history`)).status).toBe(200);
    expect((await get(anna, `/api/v1/tickets/${ticket.key}/status-history?format=csv`)).status).toBe(403);
    expect((await get<Ticket>(anna, `/api/v1/tickets/${ticket.key}`)).body.permissions.export).toBe(false);
    expect((await admin.request("GET", `/api/v1/tickets/${ticket.key}/status-history?format=csv`)).statusCode).toBe(
      200,
    );
    const log = (await get<{ items: { action: string; detail: { key?: string } }[] }>(admin, "/api/v1/access/log")).body
      .items;
    expect(log.find((event) => event.action === "export.status_history")?.detail.key).toBe(ticket.key);
  });
});

describe("«View as» and «Show mode» (R-2.20)", () => {
  test("a superadmin looks through Anna's eyes: the same spaces and rights, and nothing can be changed", async () => {
    const { create, person } = await world();
    const ticket = await create(admin, "Чужое для Анны");
    expect((await send(admin, "PUT", "/api/v1/me/lens", { kind: "person", id: person("anna").id })).status).toBe(204);
    const me = (await get<Me>(admin, "/api/v1/me")).body;
    expect(me.lens).toEqual({ kind: "person", id: person("anna").id, name: "Анна Тестова", show: false });
    expect(me.user.role).toBe("superadmin");
    const asAnna = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).body.items.map((space) => space.slug);
    const annaSees = (await get<{ items: Space[] }>(anna, "/api/v1/spaces")).body.items.map((space) => space.slug);
    expect(asAnna).toEqual(annaSees);
    expect((await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).body.permissions.edit).toBe(false);
    const write = await send(admin, "PATCH", `/api/v1/tickets/${ticket.key}`, { version: ticket.version, title: "x" });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("view_as_read_only");
    expect((await send(admin, "DELETE", "/api/v1/me/lens")).status).toBe(204);
    expect((await get<Ticket>(admin, `/api/v1/tickets/${ticket.key}`)).body.permissions.edit).toBe(true);
    // Глазами человека смотрит только суперадмин.
    expect((await send(anna, "PUT", "/api/v1/me/lens", { kind: "person", id: person("ben").id })).status).toBe(403);
  });

  test("show mode «Member»: the API gives no Direction tickets in any request; turning it off returns full access", async () => {
    const { type } = await world();
    const secret = await send<Ticket>(admin, "POST", "/api/v1/tickets", {
      spaceId: "space-direction",
      typeId: type("task"),
      title: "Бюджет студии",
    });
    expect(secret.status).toBe(201);

    expect(
      (await send(admin, "PUT", "/api/v1/me/lens", { kind: "profile", id: "profile-member", show: true })).status,
    ).toBe(204);
    const me = (await get<Me>(admin, "/api/v1/me")).body;
    expect(me.lens).toEqual({ kind: "profile", id: "profile-member", name: "Участник", show: true });
    expect(me.showProfileId).toBe("profile-member");

    const spaces = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).body.items.map((space) => space.slug);
    expect(spaces).not.toContain("direction");
    expect((await get(admin, "/api/v1/tickets?spaceId=space-direction")).status).toBe(404);
    expect((await get(admin, `/api/v1/tickets/${secret.body.key}`)).status).toBe(404);
    expect((await get(admin, `/api/v1/tickets/${secret.body.key}/history`)).status).toBe(404);
    expect((await get(admin, `/api/v1/tickets/${secret.body.key}/comments`)).status).toBe(404);
    expect((await get(admin, `/api/v1/tree?rootKey=${secret.body.key}`)).status).toBe(404);
    // В режиме показа и админские разделы закрыты: роль — участник.
    expect((await get(admin, "/api/v1/access/log")).status).toBe(403);

    expect((await send(admin, "DELETE", "/api/v1/me/lens")).status).toBe(204);
    expect((await get<Me>(admin, "/api/v1/me")).body).toMatchObject({ lens: null, showProfileId: "profile-member" });
    expect((await get(admin, `/api/v1/tickets/${secret.body.key}`)).status).toBe(200);
  });
});
