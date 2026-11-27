import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CatalogReport, FeatureTeam, Guild, Person } from "@yourtask/contracts";
import type { DevCatalog } from "../src/catalog/dev-catalog.js";
import { client, createTestApp, csrf, FakeCatalog, location, me, signIn, type Client } from "./helpers.js";

/** YT-03: люди из общего каталога YourSpace (R-2.2, docs/adr/0009). */
let app: FastifyInstance;
afterEach(async () => app?.close());

const EXPORT_TOKEN = "export-token-for-yourspace-0123456789abcdef";

async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as T & { code?: string } };
}

async function get<T>(user: Client, url: string) {
  return (await user.request("GET", url)).json() as T;
}

async function setup() {
  app = await createTestApp({ catalogExportToken: EXPORT_TOKEN });
  const catalog = app.catalogSync.catalog as DevCatalog;
  const admin = (await signIn(app, { login: "admin" })).user;
  return { catalog, admin };
}

const findPerson = async (user: Client, q: string, all = false) =>
  (
    await get<{ items: Person[] }>(
      user,
      `/api/v1/people?q=${encodeURIComponent(q)}${all ? "&includeDeactivated=true" : ""}`,
    )
  ).items[0];

describe("people come from the YourSpace catalog", () => {
  test("a new catalog member is at once available for assignment in YourTask", async () => {
    const { catalog, admin } = await setup();
    const account = catalog.create({ login: "zhenya", fullName: "Женя Новенькая", email: "zhenya@yourspace.test" });
    await app.catalogSync.sync();

    const person = await findPerson(admin, "Женя");
    expect(person).toMatchObject({
      name: "Женя Новенькая",
      email: "zhenya@yourspace.test",
      linked: true,
      deactivated: false,
    });
    expect(person?.catalog).toMatchObject({ username: "zhenya", profileUrl: `/dev/yourspace/people/${account.id}` });
    const owls = (await get<{ items: FeatureTeam[] }>(admin, "/api/v1/feature-teams")).items.find(
      (t) => t.name === "Совы",
    );
    const assigned = await send<Person>(admin, "PATCH", `/api/v1/people/${person?.id}`, { teamIds: [owls?.id] });
    expect(assigned.body.teams.map((team) => team.name)).toEqual(["Совы"]);

    // И может войти сразу, без ожидания опроса: перед входом профиль перечитывается.
    const fresh = catalog.create({ login: "lena", fullName: "Лена Сразу", email: "lena@yourspace.test" });
    const { user } = await signIn(app, { login: "lena" });
    expect((await me(user)).json().user).toMatchObject({ name: "Лена Сразу", role: "member" });
    expect((await findPerson(admin, "Лена"))?.catalog?.username).toBe(fresh.login);
  });

  test("a Telegram change in the YourSpace profile is visible on the YourTask person card", async () => {
    const { catalog, admin } = await setup();
    const anna = await findPerson(admin, "anna");
    expect(anna?.catalog?.telegram).toBe("@anna_test");
    catalog.update("ys-test-anna", { telegram: "@anna_new" });
    await app.catalogSync.sync();
    expect((await get<Person>(admin, `/api/v1/people/${anna?.id}`)).catalog?.telegram).toBe("@anna_new");
  });

  test("deactivation closes sign-in at once and keeps the name in history", async () => {
    const { catalog, admin } = await setup();
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await me(anna)).statusCode).toBe(200);
    const annaId = (await findPerson(admin, "anna"))?.id;

    catalog.setActive("ys-test-anna", false);
    await app.catalogSync.sync();

    expect((await me(anna)).statusCode).toBe(401);
    // Новая попытка входа отклоняется ещё в заглушке (как в YourSpace) — и в YourTask, если до неё дошло.
    const retry = await signIn(app, { login: "anna" });
    expect(retry.response.statusCode).toBe(401);

    // Из списка для назначения ушла, но карточка, имя и участие в командах остались.
    expect(await findPerson(admin, "anna")).toBeUndefined();
    const card = await get<Person>(admin, `/api/v1/people/${annaId}`);
    expect(card).toMatchObject({ name: "Анна Тестова", deactivated: true });
    expect(card.teams.map((team) => team.name).sort()).toEqual(["Ежи", "Совы"]);
    const owls = (await get<{ items: FeatureTeam[] }>(admin, "/api/v1/feature-teams")).items.find(
      (t) => t.name === "Совы",
    );
    expect(owls?.members.find((member) => member.id === annaId)).toMatchObject({
      name: "Анна Тестова",
      deactivated: true,
    });

    catalog.setActive("ys-test-anna", true);
    await app.catalogSync.sync();
    expect((await findPerson(admin, "anna"))?.deactivated).toBe(false);
  });

  test("a deactivated person is refused by YourTask even with a valid YourSpace code", async () => {
    const { catalog } = await setup();
    const user = client(app);
    // Начали вход, пока Анна активна…
    let response = await user.request("GET", "/api/v1/auth/login");
    response = await user.request("GET", location(response));
    const fields = Object.fromEntries(
      [...response.body.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]),
    ) as Record<string, string>;
    response = await user.form("/dev/yourspace/authorize", { ...fields, login: "anna", password: "yourspace" });
    // …и её деактивировали до того, как браузер вернулся в YourTask.
    catalog.setActive("ys-test-anna", false);
    response = await user.request("GET", location(response));
    expect(location(response)).toBe("/login?error=account_deactivated");
  });

  test("sensitive fields reach YourTask only masked, for every viewer", async () => {
    const { admin } = await setup();
    const anna = await findPerson(admin, "anna");
    // Даже суперадмин видит в YourTask маску; без маски — только в профиле YourSpace (R-2.2).
    expect(anna?.catalog?.masked).toEqual({
      phone: "+… 22",
      extraEmail: null,
      birthDate: "…",
      comments: null,
      unavailabilityRisk: null,
    });
    const pm = (await signIn(app, { login: "ben" })).user; // ПМ команды «Лисы»
    const asPm = await get<Person>(pm, `/api/v1/people/${anna?.id}`);
    expect(JSON.stringify(asPm)).not.toContain("900 000-11-22");
    expect(JSON.stringify(asPm)).not.toContain("1995-04-12");
  });

  test("raw sensitive values from the catalog are masked before they are stored", async () => {
    const catalog = new FakeCatalog();
    catalog.put({
      id: "ys-test-admin",
      fullName: "Суперадмин Тестовый",
      role: "superadmin",
      contactEmail: "admin@yourspace.test",
    });
    catalog.put({
      id: "ys-raw",
      fullName: "Сырой Телефон",
      phone: "+7 912 345-67-89",
      birthDate: "1990-01-02",
      extraEmail: "secret@example.com",
      comments: "личное",
      unavailabilityRisk: "high",
    });
    app = await createTestApp({}, { catalog });
    const admin = (await signIn(app, { login: "admin" })).user;
    const person = await findPerson(admin, "Сырой");
    expect(person?.catalog?.masked).toEqual({
      phone: "+… 89",
      extraEmail: "s…@example.com",
      birthDate: "…",
      comments: "…",
      unavailabilityRisk: "…",
    });
    const stored = JSON.stringify(
      (
        app as unknown as { catalogSync: { options: { db: { prepare(sql: string): { all(): unknown[] } } } } }
      ).catalogSync.options.db
        .prepare("SELECT * FROM catalog_profiles")
        .all(),
    );
    for (const raw of ["345-67-89", "1990-01-02", "secret@", "личное", "high"]) expect(stored).not.toContain(raw);
  });

  test("YourSpace being down keeps people and shows the error in the report", async () => {
    const catalog = new FakeCatalog();
    catalog.put({
      id: "ys-test-admin",
      fullName: "Суперадмин Тестовый",
      role: "superadmin",
      contactEmail: "admin@yourspace.test",
    });
    catalog.put({ id: "ys-x", fullName: "Икс Игрекович", telegram: "@x_y" });
    app = await createTestApp({}, { catalog });
    const admin = (await signIn(app, { login: "admin" })).user;
    catalog.failing = true;
    await app.catalogSync.sync().catch(() => undefined);
    expect((await findPerson(admin, "Икс"))?.catalog?.telegram).toBe("@x_y");
    const report = await get<CatalogReport>(admin, "/api/v1/catalog/report");
    expect(report.lastError).toContain("YourSpace is down");
    expect((await send(admin, "POST", "/api/v1/catalog/sync")).body.code).toBe("catalog_unavailable");
  });
});

describe("matching report for people added before the catalog", () => {
  test("legacy people are matched by email; the rest is resolved by the superadmin until nothing is left", async () => {
    const { admin } = await setup();
    let report = await get<CatalogReport>(admin, "/api/v1/catalog/report");
    const byName = (name: string) => report.rows.find((row) => row.person.name === name);
    expect(byName("Ольга Пиксель")?.match).toBe("email");
    expect(byName("Анна Тестова")?.match).toBe("subject");
    expect(byName("Вера Обычная")?.match).toBe("created");
    // Пётр заведён вручную с другой почтой: однозначного совпадения нет.
    const petr = byName("Пётр Старожил");
    expect(petr).toMatchObject({ match: "unresolved", catalogId: null });
    expect(petr?.candidates.map((candidate) => candidate.name)).toEqual(["Пётр Старожилов"]);
    expect(report.counts.unresolved).toBe(1);

    // Участие, заданное вручную, переживает связывание.
    const sound = (await get<{ items: Guild[] }>(admin, "/api/v1/guilds")).items.find((g) => g.name === "Звук");
    await send(admin, "PATCH", `/api/v1/people/${petr?.person.id}`, { guildIds: [sound?.id], wipLimit: 2 });

    const resolved = await send<CatalogReport>(admin, "POST", `/api/v1/catalog/report/${petr?.person.id}/resolve`, {
      action: "link",
      catalogId: petr?.candidates[0]?.catalogId,
    });
    expect(resolved.status).toBe(200);
    report = resolved.body;
    expect(report.counts.unresolved).toBe(0);
    expect(report.rows.filter((row) => row.person.name.startsWith("Пётр"))).toEqual([
      expect.objectContaining({ match: "manual", person: expect.objectContaining({ name: "Пётр Старожилов" }) }),
    ]);
    const card = await get<Person>(admin, `/api/v1/people/${petr?.person.id}`);
    expect(card).toMatchObject({ name: "Пётр Старожилов", email: "petr@yourspace.test", wipLimit: 2, linked: true });
    expect(card.guilds.map((guild) => guild.name)).toEqual(["Звук"]);

    expect(
      (await send(admin, "POST", `/api/v1/catalog/report/${petr?.person.id}/resolve`, { action: "retire" })).body.code,
    ).toBe("conflict");
  });

  test("a legacy person with no catalog account is retired: deactivated, name kept", async () => {
    const { admin } = await setup();
    const petr = (await get<CatalogReport>(admin, "/api/v1/catalog/report")).rows.find(
      (row) => row.match === "unresolved",
    );
    const report = (
      await send<CatalogReport>(admin, "POST", `/api/v1/catalog/report/${petr?.person.id}/resolve`, {
        action: "retire",
      })
    ).body;
    expect(report.counts.unresolved).toBe(0);
    expect(report.rows.find((row) => row.person.id === petr?.person.id)).toMatchObject({
      match: "retired",
      person: { name: "Пётр Старожил", deactivated: true },
    });
    // Повторная синхронизация не «оживляет» отмеченного.
    await app.catalogSync.resync();
    expect((await get<Person>(admin, `/api/v1/people/${petr?.person.id}`)).deactivated).toBe(true);
  });

  test("only the superadmin sees and resolves the report", async () => {
    await setup();
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await anna.request("GET", "/api/v1/catalog/report")).json().code).toBe("forbidden");
    expect((await send(anna, "POST", "/api/v1/catalog/report/x/resolve", { action: "retire" })).body.code).toBe(
      "forbidden",
    );
  });
});

describe("guilds, teams, lead and PM go to YourSpace for the profile", () => {
  test("export needs the token and returns groups with heads by YourSpace account", async () => {
    const { catalog, admin } = await setup();
    const anonymous = client(app);
    expect((await anonymous.request("GET", "/api/v1/catalog/org")).statusCode).toBe(401);
    expect(
      (await anonymous.request("GET", "/api/v1/catalog/org", undefined, { authorization: "Bearer wrong" })).statusCode,
    ).toBe(401);

    // Тестовая структура в выгрузку не попадает: заводим настоящую.
    const lead = catalog.create({ login: "real-lead", fullName: "Лид Настоящий" });
    const member = catalog.create({ login: "real-member", fullName: "Участник Настоящий" });
    await app.catalogSync.sync();
    const leadId = (await findPerson(admin, "Лид"))?.id;
    const memberId = (await findPerson(admin, "Участник"))?.id;
    // Группы, созданные тестовым суперадмином, — тестовые; делаем их настоящими напрямую в базе.
    const guild = await send<Guild>(admin, "POST", "/api/v1/guilds", { name: "Код", leadId, memberIds: [memberId] });
    const team = await send<FeatureTeam>(admin, "POST", "/api/v1/feature-teams", {
      name: "Барсуки",
      pmId: leadId,
      memberIds: [memberId, leadId],
    });
    const db = (
      app.catalogSync as unknown as { options: { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } } }
    ).options.db;
    db.prepare("UPDATE guilds SET is_test = 0 WHERE id = ?").run(guild.body.id);
    db.prepare("UPDATE feature_teams SET is_test = 0 WHERE id = ?").run(team.body.id);
    await send(admin, "PATCH", `/api/v1/people/${memberId}`, { wipLimit: 4 });

    const auth = { authorization: `Bearer ${EXPORT_TOKEN}` };
    const all = (await anonymous.request("GET", "/api/v1/catalog/org", undefined, auth)).json() as {
      items: { catalogId: string }[];
    };
    expect(all.items.map((item) => item.catalogId)).not.toContain("ys-test-anna");

    const one = (await anonymous.request("GET", `/api/v1/catalog/org/${member.id}`, undefined, auth)).json();
    expect(one).toEqual({
      catalogId: member.id,
      wipLimit: 4,
      guilds: [{ id: guild.body.id, name: "Код", head: { catalogId: lead.id, name: "Лид Настоящий" }, isHead: false }],
      teams: [
        { id: team.body.id, name: "Барсуки", head: { catalogId: lead.id, name: "Лид Настоящий" }, isHead: false },
      ],
    });
    // Лид не входит в состав колодца, но колодец всё равно показывается в его профиле.
    const head = (await anonymous.request("GET", `/api/v1/catalog/org/${lead.id}`, undefined, auth)).json();
    expect(head.guilds).toEqual([expect.objectContaining({ name: "Код", isHead: true })]);
    expect(head.teams).toEqual([expect.objectContaining({ name: "Барсуки", isHead: true })]);
  });

  test("export is off without a configured token", async () => {
    app = await createTestApp();
    const response = await client(app).request("GET", "/api/v1/catalog/org", undefined, { authorization: "Bearer x" });
    expect(response.statusCode).toBe(401);
  });
});
