import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { meFixture, mockApi, renderApp } from "./utils";

const teams = {
  items: [
    { id: "t1", name: "Жабы", pm: null, members: [] },
    { id: "t2", name: "Совы", pm: { id: "p2", name: "Нина", email: "nina@x.test", deactivated: false }, members: [] },
  ],
};
const guilds = { items: [{ id: "w1", name: "ГД", lead: null, members: [] }] };
const person = {
  id: "p1",
  name: "Пётр",
  email: "petr@x.test",
  locale: "ru",
  role: "member",
  wipLimit: null,
  linked: true,
  deactivated: false,
  deactivatedAt: null,
  guilds: [],
  teams: [{ id: "t2", name: "Совы" }],
  catalog: {
    username: "petr",
    fullName: "Пётр Петров",
    nickname: null,
    telegram: "@petr_x",
    vk: null,
    city: "Казань",
    timezone: "UTC+3",
    portfolio: null,
    roleTitle: "Геймдизайнер",
    membershipStatus: "active",
    joinedAt: null,
    tenure: "1 г 8 мес",
    availabilityHours: 20,
    giteaLogin: null,
    perforceLogin: null,
    masked: { phone: "+… 42", extraEmail: null, birthDate: "…", comments: null, unavailabilityRisk: null },
    profileUrl: "https://id.example.test/people/petr",
    syncedAt: "2026-11-17T10:00:00.000Z",
  },
};
const people = {
  items: [person, { ...person, id: "p2", name: "Нина", email: "nina@x.test", teams: [], catalog: null }],
};

describe("directory", () => {
  test("superadmin puts a person into two teams and no guild", async () => {
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru", "superadmin") }),
      "GET /api/v1/people/p1": () => ({ status: 200, body: person }),
      "GET /api/v1/feature-teams": () => ({ status: 200, body: teams }),
      "GET /api/v1/guilds": () => ({ status: 200, body: guilds }),
      "PATCH /api/v1/people/p1": (init) => ({ status: 200, body: { ...person, ...JSON.parse(String(init?.body)) } }),
    });
    renderApp("/people/p1");
    const teamsField = await screen.findByRole("group", { name: /Фичекоманды/ });
    await waitFor(() => expect(within(teamsField).getByLabelText("Жабы")).toBeInTheDocument());
    await userEvent.click(within(teamsField).getByLabelText("Жабы"));
    await userEvent.type(screen.getByLabelText("Личная норма WIP"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Сохранено")).toBeInTheDocument();
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")?.init?.body));
    expect(body).toMatchObject({
      teamIds: ["t2", "t1"],
      guildIds: [],
      wipLimit: 4,
    });
    // Имя и почту ведёт профиль YourSpace — YourTask их не отправляет.
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("email");
  });

  test("person card shows the YourSpace profile read-only with sensitive fields masked", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
      "GET /api/v1/people/p1": () => ({ status: 200, body: person }),
      "GET /api/v1/feature-teams": () => ({ status: 200, body: teams }),
      "GET /api/v1/guilds": () => ({ status: 200, body: guilds }),
    });
    renderApp("/people/p1");
    expect(await screen.findByRole("heading", { name: "Профиль YourSpace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "@petr_x" })).toHaveAttribute("href", "https://t.me/petr_x");
    expect(screen.getByText("+… 42")).toBeInTheDocument();
    expect(screen.getByText("1 г 8 мес")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Открыть профиль в YourSpace" })).toHaveAttribute(
      "href",
      "https://id.example.test/people/petr",
    );
    expect(screen.queryByLabelText("Имя")).not.toBeInTheDocument();
  });

  test("own profile has logout and sidebar has no duplicate account block", async () => {
    const self = { ...person, id: "u1", name: "Анна Тестова", email: "anna@yourspace.test" };
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
      "GET /api/v1/people/u1": () => ({ status: 200, body: self }),
      "GET /api/v1/feature-teams": () => ({ status: 200, body: teams }),
      "GET /api/v1/guilds": () => ({ status: 200, body: guilds }),
      "POST /api/v1/auth/logout": () => ({ status: 204 }),
    });
    renderApp("/people/u1");
    const logout = await screen.findByRole("button", { name: "Выйти" });
    const nav = screen.getByRole("navigation", { name: "Навигация" });
    const sidebar = nav.closest("aside");
    expect(sidebar?.querySelector(".app-sidebar__account")).toBeNull();
    expect(sidebar?.querySelector(".app-account__avatar")).toBeNull();
    expect(within(sidebar as HTMLElement).queryByRole("button", { name: "Выйти" })).not.toBeInTheDocument();
    await userEvent.click(logout);
    expect(await screen.findByRole("heading", { name: "Вход в YourTask" })).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/v1/auth/logout")).toHaveLength(1);
  });

  test("another person's profile does not offer logout", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
      "GET /api/v1/people/p1": () => ({ status: 200, body: person }),
      "GET /api/v1/feature-teams": () => ({ status: 200, body: teams }),
      "GET /api/v1/guilds": () => ({ status: 200, body: guilds }),
    });
    renderApp("/people/p1");
    expect(await screen.findByRole("heading", { name: "Пётр" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Выйти" })).not.toBeInTheDocument();
  });

  test("failed logout keeps the profile open and shows the localized error", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/people/u1": () => ({ status: 200, body: { ...person, id: "u1" } }),
      "GET /api/v1/feature-teams": () => ({ status: 200, body: teams }),
      "GET /api/v1/guilds": () => ({ status: 200, body: guilds }),
      "POST /api/v1/auth/logout": () => ({
        status: 500,
        body: { status: 500, code: "internal_error", title: "Server error", type: "x", requestId: "req-42" },
      }),
    });
    renderApp("/people/u1", "en");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server error. It has been logged.");
    expect(screen.getByRole("heading", { name: "Пётр" })).toBeInTheDocument();
  });

  test("people list hides the deactivated until asked and has no add form", async () => {
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru", "superadmin") }),
      "GET /api/v1/people": () => ({ status: 200, body: people }),
      "GET /api/v1/people?includeDeactivated=true": () => ({
        status: 200,
        body: { items: [...people.items, { ...person, id: "p3", name: "Ушедший", deactivated: true }] },
      }),
    });
    renderApp("/people");
    expect(await screen.findByRole("link", { name: "Пётр" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Добавить/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Показать деактивированных"));
    expect(await screen.findByRole("link", { name: "Ушедший" })).toBeInTheDocument();
    expect(screen.getByText("деактивирован")).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith("includeDeactivated=true"))).toBe(true);
  });

  test("superadmin resolves the last unresolved row of the matching report", async () => {
    const row = {
      person: { id: "p9", name: "Пётр Старожил", email: "old@x.test", deactivated: false },
      match: "unresolved",
      catalogId: null,
      candidates: [{ catalogId: "ys-petr", name: "Пётр Старожилов", email: "petr@x.test" }],
    };
    const counts = { subject: 3, email: 6, manual: 0, created: 1, retired: 0, unresolved: 1 };
    const report = { lastSyncAt: "2026-11-17T10:00:00.000Z", lastError: null, counts, rows: [row] };
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru", "superadmin") }),
      "GET /api/v1/catalog/report": () => ({ status: 200, body: report }),
      "POST /api/v1/catalog/report/p9/resolve": () => ({
        status: 200,
        body: {
          ...report,
          counts: { ...counts, manual: 1, unresolved: 0 },
          rows: [{ ...row, match: "manual", candidates: [] }],
        },
      }),
    });
    renderApp("/people/catalog-report");
    expect(await screen.findByText("Неразобранных строк: 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Связать" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "POST")?.init?.body))).toEqual({
      action: "link",
      catalogId: "ys-petr",
    });
  });

  test("changing a guild lead sends leadId", async () => {
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru", "superadmin") }),
      "GET /api/v1/guilds/w1": () => ({ status: 200, body: guilds.items[0] }),
      "GET /api/v1/people": () => ({ status: 200, body: people }),
      "PATCH /api/v1/guilds/w1": () => ({ status: 200, body: { ...guilds.items[0], lead: people.items[1] } }),
    });
    renderApp("/guilds/w1");
    const lead = await screen.findByLabelText("Лид");
    await waitFor(() => expect(within(lead).getByRole("option", { name: "Нина" })).toBeInTheDocument());
    await userEvent.selectOptions(lead, "p2");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "PATCH")?.init?.body))).toMatchObject({
      leadId: "p2",
    });
  });

  test("members see the directory read-only", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/guilds/w1": () => ({ status: 200, body: guilds.items[0] }),
      "GET /api/v1/people": () => ({ status: 200, body: people }),
    });
    renderApp("/guilds/w1");
    expect(await screen.findByText("Only a superadmin can change the directory.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Lead")).toBeDisabled();
  });

  test("dimension builder creates a multiple-choice list", async () => {
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru", "superadmin") }),
      "GET /api/v1/dimensions": () => ({ status: 200, body: { items: [] } }),
      "POST /api/v1/dimensions": (init) => ({
        status: 201,
        body: { id: "d1", key: "k", system: false, options: [], source: null, ...JSON.parse(String(init?.body)) },
      }),
    });
    renderApp("/dimensions");
    await userEvent.type(await screen.findByLabelText("Название"), "Платформа");
    await userEvent.type(screen.getByLabelText("Значения списка"), "iOS\nAndroid\n\n");
    await userEvent.click(screen.getByLabelText("Множественный"));
    await userEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByText("Сохранено: Платформа")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((call) => call.method === "POST")?.init?.body))).toEqual({
      name: "Платформа",
      kind: "list",
      multiple: true,
      options: ["iOS", "Android"],
    });
  });

  test("API errors on save are shown by code", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en", "superadmin") }),
      "GET /api/v1/feature-teams": () => ({ status: 200, body: teams }),
      "POST /api/v1/feature-teams": () => ({
        status: 409,
        body: { status: 409, code: "conflict", title: "c", type: "x", requestId: "r" },
      }),
    });
    renderApp("/teams");
    await userEvent.type(await screen.findByLabelText("Name"), "Жабы");
    await userEvent.click(screen.getByRole("button", { name: "New feature team" }));
    expect(await screen.findByText("Data conflict. Reload the page.")).toBeInTheDocument();
  });
});
