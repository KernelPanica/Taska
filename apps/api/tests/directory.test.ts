import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Dimension, FeatureTeam, Person, Space, Guild } from "@yourtask/contracts";
import type { DevCatalog } from "../src/catalog/dev-catalog.js";
import { createTestApp, csrf, me, signIn, type Client } from "./helpers.js";

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

async function get<T>(user: Client, url: string) {
  return (await user.request("GET", url)).json() as T;
}

describe("team structure (R-2.14)", () => {
  test("three feature teams with PMs and six guilds with leads are in place", async () => {
    const teams = (await get<{ items: FeatureTeam[] }>(admin, "/api/v1/feature-teams")).items;
    const guilds = (await get<{ items: Guild[] }>(admin, "/api/v1/guilds")).items;
    expect(teams).toHaveLength(3);
    expect(teams.every((team) => team.pm !== null)).toBe(true);
    expect(guilds).toHaveLength(6);
    expect(guilds.every((guild) => guild.lead !== null)).toBe(true);
  });

  test("a person can be in two teams and in no guild", async () => {
    const people = (await get<{ items: Person[] }>(admin, "/api/v1/people?q=анна")).items;
    expect(people).toHaveLength(1);
    expect(people[0]?.teams.map((team) => team.name).sort()).toEqual(["Ежи", "Совы"]);
    expect(people[0]?.guilds).toEqual([]);
  });

  test("superadmin adds team Жабы, guild ГД with a lead and a person in two teams", async () => {
    // Людей заводят в каталоге YourSpace (YT-03); здесь их только распределяют по группам.
    const catalog = app.catalogSync.catalog as DevCatalog;
    catalog.create({ login: "galya", fullName: "Галя Дизайн", email: "galya@yourspace.test" });
    catalog.create({ login: "petya", fullName: "Петя Двойной", email: "petya@yourspace.test" });
    await app.catalogSync.sync();
    const find = async (q: string) =>
      (await get<{ items: Person[] }>(admin, `/api/v1/people?q=${q}`)).items[0] as Person;
    const galya = await find("galya");
    expect(galya).toMatchObject({ name: "Галя Дизайн", linked: true, wipLimit: null, guilds: [], teams: [] });
    expect((await send<Person>(admin, "PATCH", `/api/v1/people/${galya.id}`, { wipLimit: 3 })).body.wipLimit).toBe(3);

    const toads = await send<FeatureTeam>(admin, "POST", "/api/v1/feature-teams", { name: "Жабы", pmId: galya.id });
    expect(toads.status).toBe(201);
    const gd = await send<Guild>(admin, "POST", "/api/v1/guilds", {
      name: "ГД",
      leadId: galya.id,
      memberIds: [galya.id],
    });
    expect(gd.body.lead?.name).toBe("Галя Дизайн");

    const owls = (await get<{ items: FeatureTeam[] }>(admin, "/api/v1/feature-teams")).items.find(
      (team) => team.name === "Совы",
    );
    const petya = await find("petya");
    const person = await send<Person>(admin, "PATCH", `/api/v1/people/${petya.id}`, {
      locale: "en",
      teamIds: [toads.body.id, owls?.id],
    });
    expect(person.body.teams.map((team) => team.name).sort()).toEqual(["Жабы", "Совы"]);
    expect(person.body.guilds).toEqual([]);
    const toadsCard = await get<FeatureTeam>(admin, `/api/v1/feature-teams/${toads.body.id}`);
    expect(toadsCard.members.map((member) => member.name)).toEqual(["Петя Двойной"]);
  });

  test("changing a guild lead persists", async () => {
    const guild = (await get<{ items: Guild[] }>(admin, "/api/v1/guilds")).items.find(
      (item) => item.name === "Арт",
    ) as Guild;
    const nina = (await get<{ items: Person[] }>(admin, "/api/v1/people?q=nina")).items[0] as Person;
    const updated = await send<Guild>(admin, "PATCH", `/api/v1/guilds/${guild.id}`, { leadId: nina.id });
    expect(updated.body.lead?.id).toBe(nina.id);
    expect((await get<Guild>(admin, `/api/v1/guilds/${guild.id}`)).lead?.id).toBe(nina.id);
    const cleared = await send<Guild>(admin, "PATCH", `/api/v1/guilds/${guild.id}`, { leadId: null });
    expect(cleared.body.lead).toBeNull();
  });

  test("person card replaces guilds and teams and keeps other fields", async () => {
    const olga = (await get<{ items: Person[] }>(admin, "/api/v1/people?q=olga")).items[0] as Person;
    const guilds = (await get<{ items: Guild[] }>(admin, "/api/v1/guilds")).items;
    const sound = guilds.find((guild) => guild.name === "Звук") as Guild;
    const result = await send<Person>(admin, "PATCH", `/api/v1/people/${olga.id}`, {
      guildIds: [sound.id],
      teamIds: [],
      wipLimit: 5,
    });
    expect(result.body).toMatchObject({ name: "Ольга Пиксель", wipLimit: 5, guilds: [{ name: "Звук" }], teams: [] });
    expect((await get<Guild>(admin, `/api/v1/guilds/${sound.id}`)).members.map((member) => member.name)).toContain(
      "Ольга Пиксель",
    );
  });

  test("invalid references, duplicates and bad values are rejected in the unified format", async () => {
    expect((await send(admin, "POST", "/api/v1/guilds", { name: "X", leadId: "nobody" })).body).toMatchObject({
      code: "validation_failed",
      errors: [{ field: "leadId" }],
    });
    expect((await send(admin, "POST", "/api/v1/guilds", { name: "Арт" })).body.code).toBe("conflict");
    const anna = (await get<{ items: Person[] }>(admin, "/api/v1/people?q=anna")).items[0] as Person;
    // Имя и почту ведёт профиль YourSpace, а не YourTask.
    expect((await send(admin, "PATCH", `/api/v1/people/${anna.id}`, { name: "Другое имя" })).body.code).toBe(
      "validation_failed",
    );
    expect((await send(admin, "PATCH", `/api/v1/people/${anna.id}`, { wipLimit: -1 })).body.code).toBe(
      "validation_failed",
    );
    expect((await send(admin, "POST", "/api/v1/people", { name: "N", email: "n@x.test" })).status).toBe(404);
    expect((await send(admin, "POST", "/api/v1/feature-teams", { name: "   " })).body.code).toBe("validation_failed");
  });

  test("members read the directory but only the superadmin changes it", async () => {
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await get<{ items: Guild[] }>(anna, "/api/v1/guilds")).items).toHaveLength(6);
    expect((await send(anna, "POST", "/api/v1/guilds", { name: "Тайный" })).body.code).toBe("forbidden");
    const self = (await me(anna)).json().user as { id: string };
    expect((await send(anna, "PATCH", `/api/v1/people/${self.id}`, { wipLimit: 99 })).body.code).toBe("forbidden");
  });

  test("regular users do not see the test structure", async () => {
    const vera = (await signIn(app, { login: "vera" })).user;
    expect((await get<{ items: Guild[] }>(vera, "/api/v1/guilds")).items).toEqual([]);
    expect((await get<{ items: FeatureTeam[] }>(vera, "/api/v1/feature-teams")).items).toEqual([]);
    const emails = (await get<{ items: Person[] }>(vera, "/api/v1/people")).items.map((person) => person.email);
    expect(emails).toContain("vera@yourspace.test");
    expect(emails).not.toContain("anna@yourspace.test");
    expect(emails).not.toContain("olga@yourspace.test");
  });
});

describe("spaces (R-2.16)", () => {
  test("start spaces exist; superadmin creates and renames", async () => {
    const names = (await get<{ items: Space[] }>(admin, "/api/v1/spaces")).items.map((space) => space.name);
    for (const name of ["Дирекция", "Core", "Инфраструктура", "Производство"]) expect(names).toContain(name);

    const created = await send<Space>(admin, "POST", "/api/v1/spaces", { name: "Маркетинг игр" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: "marketing-igr", name: "Маркетинг игр", role: null });
    const renamed = await send<Space>(admin, "PATCH", `/api/v1/spaces/${created.body.id}`, { name: "Маркетинг" });
    expect(renamed.body).toMatchObject({ slug: "marketing-igr", name: "Маркетинг" });
    expect((await get<Space>(admin, "/api/v1/spaces/marketing-igr")).name).toBe("Маркетинг");
    expect((await send(admin, "POST", "/api/v1/spaces", { name: "Core", slug: "core" })).body.code).toBe("conflict");
  });

  test("members see only their spaces and cannot create", async () => {
    const anna = (await signIn(app, { login: "anna" })).user;
    // Дирекция и Core закрыты: Анна не ПМ и не лид; остальное — по стартовым выдачам (R-2.16, YT-08).
    expect((await get<{ items: Space[] }>(anna, "/api/v1/spaces")).items.map((space) => space.slug)).toEqual([
      "infrastructure",
      "production",
      "test",
    ]);
    expect((await send(anna, "POST", "/api/v1/spaces", { name: "Моё" })).body.code).toBe("forbidden");
  });
});

describe("dimension builder (R-2.15)", () => {
  test("team and stream are the start dimensions", async () => {
    const items = (await get<{ items: Dimension[] }>(admin, "/api/v1/dimensions")).items;
    // R-2.14: «Фичекоманда» (team) — одно значение или пусто; «Стрим» (stream) — несколько значений.
    expect(
      items.map(({ key, name, kind, source, multiple, system }) => ({ key, name, kind, source, multiple, system })),
    ).toEqual([
      { key: "stream", name: "Стрим", kind: "people_group", source: "guilds", multiple: true, system: true },
      {
        key: "team",
        name: "Фичекоманда",
        kind: "people_group",
        source: "feature_teams",
        multiple: false,
        system: true,
      },
    ]);
  });

  test("admin creates a multiple-choice list without a developer", async () => {
    const created = await send<Dimension>(admin, "POST", "/api/v1/dimensions", {
      name: "Платформа",
      kind: "list",
      multiple: true,
      options: ["iOS", "Android", " android ", "Web"],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: "platforma", kind: "list", source: null, multiple: true, system: false });
    expect(created.body.options.map((option) => option.label)).toEqual(["iOS", "Android", "Web"]);

    const ios = created.body.options[0];
    const edited = await send<Dimension>(admin, "PATCH", `/api/v1/dimensions/${created.body.id}`, {
      options: ["Web", "iOS", "Switch"],
      multiple: false,
    });
    expect(edited.body.multiple).toBe(false);
    expect(edited.body.options.map((option) => option.label)).toEqual(["Web", "iOS", "Switch"]);
    expect(edited.body.options[1]?.id).toBe(ios?.id);

    expect((await send(admin, "DELETE", `/api/v1/dimensions/${created.body.id}`)).status).toBe(204);
  });

  test("people group needs a source; system dimensions cannot be deleted; members cannot build", async () => {
    expect(
      (await send(admin, "POST", "/api/v1/dimensions", { name: "G", kind: "people_group", multiple: false })).body,
    ).toMatchObject({
      code: "validation_failed",
      errors: [{ field: "source" }],
    });
    expect(
      (await send(admin, "POST", "/api/v1/dimensions", { name: "L", kind: "list", source: "guilds", multiple: false }))
        .body.code,
    ).toBe("validation_failed");
    const group = await send<Dimension>(admin, "POST", "/api/v1/dimensions", {
      name: "Ревьюеры",
      kind: "people_group",
      source: "guilds",
      multiple: true,
    });
    expect(group.body).toMatchObject({ kind: "people_group", source: "guilds", multiple: true, options: [] });
    expect((await send(admin, "PATCH", `/api/v1/dimensions/${group.body.id}`, { options: ["x"] })).body.code).toBe(
      "validation_failed",
    );

    const team = (await get<{ items: Dimension[] }>(admin, "/api/v1/dimensions")).items.find(
      (item) => item.key === "team",
    ) as Dimension;
    expect((await send(admin, "DELETE", `/api/v1/dimensions/${team.id}`)).body.code).toBe("conflict");
    expect(
      (await send(admin, "POST", "/api/v1/dimensions", { name: "Платформа", kind: "list", multiple: true })).status,
    ).toBe(201);
    expect(
      (await send(admin, "POST", "/api/v1/dimensions", { name: "Платформа", kind: "list", multiple: true })).body.code,
    ).toBe("conflict");

    const anna = (await signIn(app, { login: "anna" })).user;
    expect(
      (await send(anna, "POST", "/api/v1/dimensions", { name: "Z", kind: "list", multiple: false })).body.code,
    ).toBe("forbidden");
  });
});
