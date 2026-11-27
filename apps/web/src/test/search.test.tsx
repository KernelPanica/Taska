import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test } from "vitest";
import { meFixture, mockApi, renderApp, SPACE_RIGHTS } from "./utils";

/** YT-15 в интерфейсе: конструктор из чипов, текст с подсказками и ошибками, сохранённые фильтры. */
const vocabulary = {
  customFields: [{ key: "severity", name: "Серьёзность", kind: "list" }],
  values: {
    type: [{ name: "bug", label: "Баг" }],
    status: [{ name: "To Do", label: "To Do" }],
    statusCategory: [
      { name: "queue", label: "queue" },
      { name: "active", label: "active" },
      { name: "done", label: "done" },
    ],
    resolution: [],
    zone: [{ name: "Delivery", label: "Delivery" }],
    space: [{ name: "production", label: "Производство" }],
    team: [{ name: "Frogs", label: "Жабы" }],
    guild: [{ name: "GD", label: "ГД" }],
    person: [{ name: "anna", label: "Анна Тестова" }],
    priority: [{ name: "highest", label: "highest" }],
    bool: [],
    linkType: [],
  },
};
const space = {
  id: "space-production",
  slug: "production",
  name: "Производство",
  role: "member",
  rights: [...SPACE_RIGHTS, "boards_space"],
  enforceSubordination: false,
  createdAt: "2026-11-01T00:00:00.000Z",
};
const found = {
  items: [
    {
      id: "t1",
      key: "AOS-5",
      title: "Сценарий боя",
      typeId: "type-story",
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
      numbers: ["1.2"],
      spaceId: "space-production",
    },
  ],
  total: 1,
  query: "stream = GD or assignee.guild = GD",
  tree: { where: null, orderBy: [] },
  tookMs: 12,
};

function api(extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
    "GET /api/v1/spaces": () => ({ status: 200, body: { items: [space] } }),
    "GET /api/v1/search/vocabulary": () => ({ status: 200, body: vocabulary }),
    "GET /api/v1/filters": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/filters?spaceId=space-production": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/ticket-types": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/notifications": () => ({ status: 200, body: { items: [], unread: 0 } }),
    ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe("TQL builder and text (YT-15)", () => {
  test("the lead builds «stream = GD or assignee.guild = GD» with chips, switches to text and back without changes", async () => {
    api();
    renderApp("/search");
    expect(await screen.findByRole("button", { name: /Конструктор/, pressed: true })).toBeInTheDocument();

    const addCondition = async (field: string, value: string) => {
      await userEvent.click(screen.getByRole("button", { name: "условие" }));
      const form = screen.getByRole("group", { name: "Условие" });
      await userEvent.selectOptions(within(form).getByLabelText("Поле"), field);
      await userEvent.type(within(form).getByLabelText("Значение"), value);
      await userEvent.click(within(form).getByRole("button", { name: "Сохранить" }));
    };
    await addCondition("stream", "GD");
    await addCondition("assignee.guild", "GD");
    await userEvent.click(screen.getByRole("button", { name: /^и —/ }));
    expect(screen.getByRole("button", { name: "stream = GD" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Текст/ }));
    expect(screen.getByLabelText("Запрос TQL")).toHaveValue("stream = GD or assignee.guild = GD");
    await userEvent.click(screen.getByRole("button", { name: /Конструктор/ }));
    expect(screen.getByRole("button", { name: "stream = GD" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "assignee.guild = GD" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^или —/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Текст/ }));
    expect(screen.getByLabelText("Запрос TQL")).toHaveValue("stream = GD or assignee.guild = GD");
  });

  test("an error in the text is highlighted with a clear hint; the builder waits until it is fixed", async () => {
    localStorage.setItem("tql.mode", "text");
    api();
    renderApp("/search");
    const input = await screen.findByLabelText("Запрос TQL");
    fireEvent.change(input, { target: { value: "staus = Done" } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Нет поля «staus». Может быть, status?");
    expect(alert.querySelector("mark")).toHaveTextContent("staus");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /Конструктор/ })).toBeDisabled();

    fireEvent.change(input, { target: { value: "team = Жабы" } });
    expect(await screen.findByRole("alert")).toHaveTextContent('возьмите его в кавычки: "Жабы"');
  });

  test("autocomplete suggests fields, then operators, then values with display names", async () => {
    localStorage.setItem("tql.mode", "text");
    api();
    renderApp("/search");
    const input = await screen.findByLabelText("Запрос TQL");
    await userEvent.type(input, "stre");
    const list = await screen.findByRole("listbox", { name: "Подсказки" });
    expect(within(list).getByRole("option", { name: /stream/ })).toBeInTheDocument();
    await userEvent.keyboard("{Tab}");
    expect(input).toHaveValue("stream");
    await userEvent.type(input, " ");
    expect(within(await screen.findByRole("listbox")).getAllByRole("option")[0]).toHaveTextContent("=");
    await userEvent.keyboard("{Tab}");
    expect(within(await screen.findByRole("listbox")).getByRole("option", { name: /ГД · GD/ })).toBeInTheDocument();
    await userEvent.keyboard("{Tab}");
    expect(input).toHaveValue("stream = GD");
  });

  test("results show the count within the viewer's rights; a filter is saved for everyone in the space", async () => {
    const calls = api({
      "GET /api/v1/search?q=stream%20%3D%20GD%20or%20assignee.guild%20%3D%20GD&limit=100&spaceId=space-production":
        () => ({
          status: 200,
          body: found,
        }),
      "POST /api/v1/filters": (init) => ({
        status: 201,
        body: {
          id: "f1",
          ...JSON.parse(String(init?.body)),
          owner: { id: "u1", name: "Бен" },
          canEdit: true,
          updatedAt: "2026-11-19T00:00:00Z",
        },
      }),
    });
    renderApp(`/search?q=${encodeURIComponent("stream = GD or assignee.guild = GD")}&space=production`);
    expect(await screen.findByText("Найдено: 1 · 12 мс")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "AOS-5 Сценарий боя" })).toHaveAttribute("href", "/tickets/AOS-5");

    await userEvent.type(screen.getByLabelText("Сохранить как"), "Доска лида ГД");
    await userEvent.click(screen.getByRole("checkbox", { name: "Для всех в «Производство»" }));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить фильтр" }));
    expect(await screen.findByText("Фильтр «Доска лида ГД» сохранён для всех.")).toBeInTheDocument();
    await waitFor(() =>
      expect(JSON.parse(String(calls.find((call) => call.method === "POST")?.init?.body))).toEqual({
        name: "Доска лида ГД",
        query: "stream = GD or assignee.guild = GD",
        shared: true,
        spaceId: "space-production",
      }),
    );
  });
});
