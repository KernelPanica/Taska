import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { AppNotification } from "@yourtask/contracts";
import { meFixture, mockApi, renderApp } from "./utils";

/** YT-18 в интерфейсе: колокольчик, пакет, живая запись, всплывающее, настройки, массовая правка. */
const person = { id: "u2", name: "Бен Тестер", email: "ben@yourspace.test", deactivated: false };
const ticket = (key: string, title: string, available = true) => ({
  id: `id-${key}`,
  key: available ? key : null,
  title: available ? title : null,
  available,
});
const note = (id: string, extra: Partial<AppNotification>): AppNotification => ({
  id,
  kind: "status_changed",
  actor: person,
  tickets: [ticket("AOS-5", "Скрипт смены камеры")],
  entries: [
    { ticket: ticket("AOS-5", "Скрипт смены камеры"), from: "Backlog", to: "To Do", excerpt: null, commentId: null },
  ],
  batch: false,
  live: true,
  batchId: null,
  createdAt: "2026-11-21T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
  read: false,
  ...extra,
});
const thirty = Array.from({ length: 30 }, (_, index) => ticket(`AOS-${100 + index}`, `Задача ${index + 1}`));

function api(items: () => AppNotification[], extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
    "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/products": () => ({ status: 200, body: { products: [] } }),
    "GET /api/v1/notifications": () => {
      const list = items();
      return { status: 200, body: { items: list, unread: list.filter((item) => !item.read).length } };
    },
    "POST /api/v1/notifications/read": () => ({ status: 204 }),
    ...extra,
  });
}

const openBell = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /Уведомления, новых/ }));
  return screen.getByRole("region", { name: "Уведомления" });
};

describe("bell", () => {
  test("the notification panel closes when another navigation control receives focus", async () => {
    api(() => [note("n1", {})]);
    renderApp("/");
    await openBell();
    fireEvent.focusIn(screen.getByRole("link", { name: "Профиль" }));
    expect(screen.queryByRole("region", { name: "Уведомления" })).toBeNull();
  });

  test("sidebar panel is portalled, retains internal focus, closes outside and restores focus on Escape", async () => {
    api(() => [note("n1", {})]);
    renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: "Открыть меню" }));
    const panel = await openBell();
    const trigger = screen.getByRole("button", { name: /Уведомления, новых/ });
    expect(panel.parentElement).toBe(document.body);
    const settings = within(panel).getByRole("link", { name: "Настроить" });
    settings.focus();
    expect(panel).toBeInTheDocument();
    fireEvent.keyDown(settings, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Уведомления" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(document.getElementById("app-sidebar")).toHaveClass("is-open");
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "Уведомления" })).toBeNull();
  });

  test("status change with its path, a batch of 30 as one line, a hidden ticket without its name", async () => {
    api(() => [
      note("n1", {
        entries: [
          {
            ticket: ticket("AOS-5", "Скрипт смены камеры"),
            from: "Backlog",
            to: "To Do",
            excerpt: null,
            commentId: null,
          },
          {
            ticket: ticket("AOS-5", "Скрипт смены камеры"),
            from: "To Do",
            to: "Creation",
            excerpt: null,
            commentId: null,
          },
        ],
      }),
      note("n2", {
        kind: "assigned",
        tickets: thirty,
        entries: thirty.map((item) => ({ ticket: item, from: null, to: null, excerpt: null, commentId: null })),
        batch: true,
        live: false,
      }),
      note("n3", {
        tickets: [ticket("AOS-9", "", false)],
        entries: [{ ticket: ticket("AOS-9", "", false), from: null, to: null, excerpt: null, commentId: null }],
        read: true,
      }),
    ]);
    renderApp("/");
    const panel = await openBell();
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Бен Тестер: AOS-5 «Скрипт смены камеры» — Backlog → To Do → Creation");
    expect(items[0]).toHaveTextContent("новое");
    expect(items[0]).toHaveTextContent("обновлялось 2 раз");
    expect(items[1]).toHaveTextContent("вас назначили на 30 тикетов");
    expect(items[1]).toHaveTextContent("и ещё 27");
    expect(items[1]).toHaveTextContent("одно сообщение на пакет");
    expect(items[2]).toHaveTextContent("Связанный тикет недоступен");
    expect(items[2]).not.toHaveTextContent("новое");
  });

  test("a click marks it read and opens the ticket; a batch opens the search by keys", async () => {
    const calls = api(() => [note("n1", {})]);
    renderApp("/");
    const panel = await openBell();
    fireEvent.click(within(panel).getByRole("button", { name: /Скрипт смены камеры/ }));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/v1/tickets/AOS-5")).toBe(true));
    const read = calls.find((call) => call.method === "POST" && call.path === "/api/v1/notifications/read");
    expect(JSON.parse(String(read?.init?.body))).toEqual({ ids: ["n1"] });
  });

  test("a new event pops up without opening the bell", async () => {
    let list: AppNotification[] = [];
    api(() => list);
    renderApp("/");
    await screen.findByRole("button", { name: "Уведомления" });
    list = [
      note("n1", {
        kind: "commented",
        entries: [
          {
            ticket: ticket("AOS-5", "Скрипт смены камеры"),
            from: null,
            to: null,
            excerpt: "Камера дёргается",
            commentId: "c1",
          },
        ],
      }),
    ];
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    const popup = await screen.findByText(/новый комментарий в AOS-5/);
    expect(popup.closest("[role=status]")).not.toBeNull();
    expect(await screen.findByRole("button", { name: "Уведомления, новых: 1" })).toBeInTheDocument();
  });
});

describe("settings and bulk edit", () => {
  test("each kind of event switches off in the profile", async () => {
    let saved: unknown = null;
    api(() => [], {
      "GET /api/v1/me/notification-settings": () => ({
        status: 200,
        body: {
          items: [
            { kind: "assigned", enabled: true },
            { kind: "mentioned", enabled: true },
            { kind: "status_changed", enabled: true },
            { kind: "commented", enabled: true },
            { kind: "team_ticket_trashed", enabled: true },
          ],
        },
      }),
      "PUT /api/v1/me/notification-settings": (init) => {
        saved = JSON.parse(String(init?.body));
        return { status: 200, body: { items: [{ kind: "status_changed", enabled: false }] } };
      },
    });
    renderApp("/settings/notifications");
    fireEvent.click(await screen.findByRole("checkbox", { name: /Смена статуса/ }));
    await waitFor(() => expect(saved).toEqual({ items: [{ kind: "status_changed", enabled: false }] }));
  });

  test("search results: select all → status for everyone in one bulk request", async () => {
    let body: Record<string, unknown> | null = null;
    const summary = (key: string, title: string) => ({
      id: `id-${key}`,
      key,
      title,
      typeId: "type-task",
      statusId: "s1",
      outcome: null,
      priority: "normal",
      assignees: [],
      blocked: false,
      archived: false,
      updatedAt: "2026-11-19T00:00:00Z",
      titleOnly: false,
      progress: null,
      coverage: 0,
      numbers: [],
      spaceId: "space-production",
    });
    api(() => [], {
      "GET /api/v1/search?q=type%20%3D%20task&limit=100": () => ({
        status: 200,
        body: {
          items: [summary("AOS-1", "Первая"), summary("AOS-2", "Вторая")],
          total: 2,
          query: "type = task",
          tree: { where: null, orderBy: [] },
          tookMs: 5,
        },
      }),
      "GET /api/v1/search/vocabulary": () => ({
        status: 200,
        body: { customFields: [], values: { status: [{ name: "To Do", label: "To Do" }], person: [] } },
      }),
      "GET /api/v1/filters": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/ticket-types": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/people": () => ({ status: 200, body: { items: [] } }),
      "POST /api/v1/tickets/bulk": (init) => {
        body = JSON.parse(String(init?.body));
        return { status: 200, body: { items: [{}, {}] } };
      },
    });
    renderApp("/search?q=type%20%3D%20task");
    const bar = await screen.findByRole("form", { name: "Массовая правка выбранного" });
    await screen.findByText("Вторая");
    fireEvent.click(within(bar).getByRole("checkbox"));
    fireEvent.change(within(bar).getByLabelText("Статус"), { target: { value: "To Do" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Изменить выбранные (2)" }));
    await waitFor(() => expect(body).toEqual({ keys: ["AOS-1", "AOS-2"], status: "To Do" }));
    expect(await screen.findByText(/Изменено тикетов: 2/)).toBeInTheDocument();
  });
});
