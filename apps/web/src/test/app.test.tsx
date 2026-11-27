import { createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { SPACE_RIGHTS, meFixture, mockApi, problem, renderApp } from "./utils";

describe("login", () => {
  test("anonymous user is sent to the YourSpace login page", async () => {
    mockApi({ "GET /api/v1/me": () => problem(401, "unauthenticated") });
    renderApp("/", "ru");
    expect(await screen.findByRole("heading", { name: "Вход в YourTask" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Войти через YourSpace" })).toHaveAttribute("href", "/api/v1/auth/login");
    expect(screen.queryByRole("link", { name: /Google/ })).not.toBeInTheDocument();
    expect(screen.getByText("При первом входе профиль YourTask создаётся автоматически.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/пароль/i)).not.toBeInTheDocument();
  });

  test("deep link survives the login round-trip", async () => {
    mockApi({ "GET /api/v1/me": () => problem(401, "unauthenticated") });
    renderApp("/spaces/test", "en");
    const link = await screen.findByRole("link", { name: "Sign in with YourSpace" });
    expect(link).toHaveAttribute("href", "/api/v1/auth/login?returnTo=%2Fspaces%2Ftest");
  });

  test("login errors from the callback are translated by code", async () => {
    mockApi({ "GET /api/v1/me": () => problem(401, "unauthenticated") });
    renderApp("/login?error=mfa_required", "en");
    expect(await screen.findByRole("alert")).toHaveTextContent("Superadmins and admins need a second sign-in factor");
  });
});

describe("workspace", () => {
  test("signed-in user sees the empty test space", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
      "GET /api/v1/spaces": () => ({
        status: 200,
        body: {
          items: [
            {
              id: "sp1",
              slug: "test",
              name: "Тестовое пространство",
              role: "member",
              rights: SPACE_RIGHTS,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
      "GET /api/v1/spaces/test": () => ({
        status: 200,
        body: {
          id: "sp1",
          slug: "test",
          name: "Тестовое пространство",
          role: "member",
          rights: SPACE_RIGHTS,
          enforceSubordination: false,
          createdAt: "2026-01-01T00:00:00Z",
        },
      }),
      "GET /api/v1/tickets?spaceId=sp1&archived=exclude&sort=number": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/ticket-types": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/", "ru");
    await userEvent.click(await screen.findByRole("link", { name: /Тестовое пространство/ }));
    expect(await screen.findByText("В пространстве пока нет тикетов")).toBeInTheDocument();
  });

  test("navigation groups are ordered and setup is hidden from members", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/boards": () => ({ status: 200, body: { items: [{ id: "b1", name: "Моя доска", kind: "mine" }] } }),
    });
    renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Навигация" });
    expect(
      within(nav)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Организация", "Мои доски", "Я"]);
    const organization = within(nav).getByRole("group", { name: "Организация" });
    const boards = within(nav).getByRole("group", { name: "Мои доски" });
    const me = within(nav).getByRole("group", { name: "Я" });
    expect(
      within(organization)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Пространства", "Доски", "Люди", "Фичекоманды", "Колодцы", "Измерения", "Корзина"]);
    expect(within(boards).getByRole("link", { name: "Мои задачи" })).toHaveAttribute("href", "/boards/b1");
    expect(
      within(me)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Сессии", "Профиль"]);
    expect(within(me).getByRole("button", { name: "Уведомления" })).toBeInTheDocument();
    expect(within(me).getByRole("link", { name: "Профиль" })).toHaveAttribute("href", "/people/u1");
    for (const href of ["/types", "/fields", "/estimates", "/link-types", "/attachment-settings", "/access"]) {
      expect(nav.querySelector(`a[href="${href}"]`)).toBeNull();
    }
    expect(nav.querySelector('a[href="/api/docs"]')).toBeNull();
  });

  test("superadmin sees the full ticket setup and API docs", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en", "superadmin") }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/", "en");
    const nav = await screen.findByRole("navigation", { name: "Navigation" });
    expect(
      within(nav)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Organization", "My boards", "Me", "Ticket setup"]);
    const setup = within(nav).getByRole("group", { name: "Ticket setup" });
    for (const href of ["/types", "/fields", "/estimates", "/link-types", "/attachment-settings", "/access"]) {
      expect(setup.querySelector(`a[href="${href}"]`)).toBeInTheDocument();
    }
    expect(nav.querySelector('a[href="/api/docs"]')).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/people/u1");
  });

  test("self profile activates Profile without activating People", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/people/u1", "en");
    const nav = await screen.findByRole("navigation", { name: "Navigation" });
    expect(within(nav).getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "People" })).not.toHaveAttribute("aria-current", "page");
  });

  test("user without spaces gets an empty state", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "You have no spaces yet" })).toBeInTheDocument();
  });

  test("switching the language updates the interface and saves it to the profile", async () => {
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
      "PATCH /api/v1/me": (init) => ({ status: 200, body: meFixture(JSON.parse(String(init?.body)).locale) }),
    });
    renderApp("/people/u1");
    await screen.findByRole("group", { name: "Язык интерфейса" });
    const switcher = screen.getByRole("group", { name: "Язык интерфейса" });
    await userEvent.click(within(switcher).getByRole("button", { name: "EN" }));
    expect(await screen.findByRole("group", { name: "Interface language" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.method === "PATCH");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ locale: "en" });
    expect(new Headers(patch?.init?.headers).get("x-yourtask-csrf")).toBe("csrf-1");
  });

  test("profile language wins over the browser default", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/", "ru");
    expect(await screen.findByRole("heading", { name: "Spaces" })).toBeInTheDocument();
  });

  test("sessions can be revoked from the interface", async () => {
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/me/sessions": () => ({
        status: 200,
        body: {
          items: [
            {
              id: "s1",
              current: true,
              method: "password",
              mfa: false,
              userAgent: "Firefox",
              ip: "127.0.0.1",
              createdAt: "2026-11-16T10:00:00Z",
              lastSeenAt: "2026-11-16T10:00:00Z",
              expiresAt: "2026-11-23T10:00:00Z",
            },
            {
              id: "s2",
              current: false,
              method: "google",
              mfa: false,
              userAgent: "Phone",
              ip: null,
              createdAt: "2026-11-15T10:00:00Z",
              lastSeenAt: "2026-11-15T10:00:00Z",
              expiresAt: "2026-11-22T10:00:00Z",
            },
          ],
        },
      }),
      "DELETE /api/v1/me/sessions/s2": () => ({ status: 204 }),
    });
    renderApp("/settings/sessions");
    const phone = (await screen.findByText("Phone")).closest(".session-card") as HTMLElement;
    await userEvent.click(within(phone).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Session revoked")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/v1/me/sessions/s2")).toBe(true);
  });

  test("API errors are shown with the request id", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/spaces": () => problem(500, "internal_error"),
    });
    renderApp("/");
    expect(await screen.findByRole("alert")).toHaveTextContent("Server error. It has been logged.");
    expect(screen.getByText("ID: req-42")).toBeInTheDocument();
  });
});

describe("sidebar layout", () => {
  test("resizes with keyboard and pointer, persists a bounded width and keeps compact names", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: meFixture("en") }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    });
    localStorage.setItem("yourtask.sidebar-width", "9999");
    renderApp("/", "en");
    const separator = await screen.findByRole("separator", { name: "Resize sidebar" });
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "72");
    expect(document.querySelector(".app-shell")).toHaveClass("is-sidebar-compact");
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute("title", "Profile");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(localStorage.getItem("yourtask.sidebar-width")).toBe("88");
    Object.defineProperty(separator, "setPointerCapture", { value: () => {} });
    const down = createEvent.pointerDown(separator);
    Object.defineProperties(down, { button: { value: 0 }, clientX: { value: 88 }, pointerId: { value: 1 } });
    fireEvent(separator, down);
    const move = createEvent.pointerMove(separator);
    Object.defineProperty(move, "clientX", { value: 256 });
    fireEvent(separator, move);
    fireEvent.pointerUp(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "256");
    expect(localStorage.getItem("yourtask.sidebar-width")).toBe("256");
    expect(document.querySelector(".app-topbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show mode" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Interface language" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(document.getElementById("app-sidebar")).toHaveClass("is-open");
  });
});

describe("active view context", () => {
  test("the retained banner names the active role and exits it", async () => {
    let lens: unknown = { kind: "profile", id: "profile-member", name: "Участник", show: true };
    const calls = mockApi({
      "GET /api/v1/me": () => ({ status: 200, body: { ...meFixture("ru", "superadmin"), lens } }),
      "DELETE /api/v1/me/lens": () => {
        lens = null;
        return { status: 204 };
      },
      "GET /api/v1/access/profiles": () => ({
        status: 200,
        body: {
          items: [{ id: "profile-member", key: "member", name: "Участник", rights: {}, system: true, grants: 1 }],
        },
      }),
      "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/");
    expect(await screen.findByText("Режим показа: Участник")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Выключить" }));
    await waitFor(() => expect(screen.queryByText("Режим показа: Участник")).toBeNull());
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/v1/me/lens")).toBe(true);
  });
});
