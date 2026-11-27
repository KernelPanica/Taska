import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { meFixture, mockApi, renderApp, SPACE_RIGHTS, ticketExtras } from "./utils";

/** YT-05/YT-06 в интерфейсе: карточка тикета и список в пространстве. */
const person = (id: string, name: string) => ({ id, name, email: `${id}@x.test`, deactivated: false });
const story = {
  id: "type-story",
  key: "story",
  name: "Стори",
  color: "#16A34A",
  icon: "book-open",
  fieldIds: ["f-due"],
  rollups: { status: false, progress: "both", progressByEstimate: false, dates: false, estimates: true },
  allowedParentTypeIds: [],
  templates: [{ id: "template-story", name: "Стори" }],
  outcomes: [
    { key: "done", label: "Выполнено" },
    { key: "cancelled", label: "Отменено" },
  ],
  system: true,
};
const fields = [
  {
    id: "f-due",
    key: "due_date",
    name: "Срок",
    kind: "date",
    options: [],
    multiple: false,
    scaleId: null,
    dimensionId: null,
    system: true,
  },
];
const status = (id: string, name: string, category: string, extra = {}) => ({
  id,
  name,
  category,
  waiting: false,
  outcomes: category === "done" ? ["done", "cancelled"] : [],
  requirements: [],
  responsibleRoles: [],
  freezeRequirements: false,
  ...extra,
});
const scheme = {
  typeId: "type-story",
  spaceId: "space-core",
  inherited: true,
  strictOrder: false,
  statuses: [
    status("s-backlog", "Backlog", "queue"),
    status("s-todo", "To Do", "queue", {
      requirements: [
        { kind: "field", fieldKey: "due_date" },
        { kind: "people", role: "assignees" },
      ],
    }),
    status("s-done", "Done", "done"),
  ],
};
const ticket = {
  id: "t1",
  key: "AOS-7",
  number: 7,
  spaceId: "space-core",
  typeId: "type-story",
  statusId: "s-backlog",
  outcome: null,
  title: "Очень длинное название стори, которое не должно ломать карточку ".repeat(3),
  description: "## Задача\nПрыгать <script>window.hacked = true</script>\n\n**жирно** [ссылка](javascript:alert(1))",
  checklist: [{ id: "c1", text: "Критерии приёмки проверены", done: false }],
  values: {},
  priority: "normal",
  tags: [],
  startDate: null,
  endDate: null,
  blocked: false,
  blockedReason: null,
  cancelReason: null,
  archived: null,
  legacyNumber: null,
  people: { assignees: [], customer: null, tester: null, watchers: [] },
  version: 3,
  createdBy: person("u1", "Анна Тестова"),
  updatedBy: person("u1", "Анна Тестова"),
  createdAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:00.000Z",
  ...ticketExtras,
};
const space = {
  id: "space-core",
  slug: "core",
  name: "Core",
  role: "member",
  rights: SPACE_RIGHTS,
  enforceSubordination: false,
  createdAt: "2026-11-01T00:00:00.000Z",
};

function api(overrides: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru", "superadmin") }),
    "GET /api/v1/tickets/AOS-7": () => ({ status: 200, body: ticket }),
    "GET /api/v1/ticket-types": () => ({ status: 200, body: { items: [story] } }),
    "GET /api/v1/ticket-types/type-story/scheme?spaceId=space-core": () => ({ status: 200, body: scheme }),
    "GET /api/v1/spaces": () => ({ status: 200, body: { items: [space] } }),
    "GET /api/v1/spaces/core": () => ({ status: 200, body: space }),
    "GET /api/v1/fields": () => ({ status: 200, body: { items: fields } }),
    "GET /api/v1/people": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/estimate-scales": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/dimensions": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/guilds": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/feature-teams": () => ({ status: 200, body: { items: [] } }),
    ...overrides,
  });
}

describe("ticket card", () => {
  test("Markdown is shown safely: scripts are text, javascript: links are not links", async () => {
    api();
    renderApp("/tickets/AOS-7");
    expect(await screen.findByRole("heading", { name: "Задача" })).toBeInTheDocument();
    expect(screen.getByText(/<script>window.hacked = true<\/script>/)).toBeInTheDocument();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
    expect(screen.getByText("жирно").tagName).toBe("STRONG");
    expect(screen.queryByRole("link", { name: "ссылка" })).not.toBeInTheDocument();
    expect(screen.getByText("ссылка")).toBeInTheDocument();
    expect(screen.getByText("AOS-7")).toBeInTheDocument();
  });

  test("a blocked move explains what to fill in", async () => {
    api({
      "POST /api/v1/tickets/AOS-7/transition": () => ({
        status: 422,
        body: {
          status: 422,
          code: "transition_blocked",
          title: "t",
          type: "x",
          requestId: "r",
          errors: [
            { field: "values.due_date", message: "fill in the field: Срок" },
            { field: "people.assignees", message: "assign: assignees" },
          ],
        },
      }),
    });
    renderApp("/tickets/AOS-7");
    await userEvent.selectOptions(await screen.findByLabelText("Перевести в"), "s-todo");
    await userEvent.click(screen.getByRole("button", { name: "Перевести" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Чтобы перейти в «To Do», заполните:");
    expect(within(alert).getByText("поле «Срок»")).toBeInTheDocument();
    expect(within(alert).getByText("исполнителя")).toBeInTheDocument();
  });

  test("a parallel edit is not lost silently: who changed what is shown, the draft stays", async () => {
    const newer = { ...ticket, title: "Чужое название", version: 4, updatedBy: person("u2", "Ben Tester") };
    api({
      "PATCH /api/v1/tickets/AOS-7": () => ({
        status: 409,
        body: { status: 409, code: "version_conflict", title: "t", type: "x", requestId: "r", current: newer },
      }),
    });
    renderApp("/tickets/AOS-7");
    const description = await screen.findByRole("heading", { name: "Описание" });
    await userEvent.click(
      within(description.closest(".ticket-section") as HTMLElement).getByRole("button", { name: "Изменить" }),
    );
    const editor = screen.getByLabelText("Описание", { selector: "textarea" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "Моя правка");
    await userEvent.click(
      within(description.closest(".ticket-section") as HTMLElement).getByRole("button", { name: "Сохранить" }),
    );
    expect(await screen.findByText(/Пока вы правили, тикет изменил\(а\) Ben Tester/)).toHaveTextContent("Название");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Чужое название");
    expect(screen.getByLabelText("Описание", { selector: "textarea" })).toHaveValue("Моя правка");
  });

  test("a done move asks for an outcome; cancelling needs a reason", async () => {
    const calls = api({
      "POST /api/v1/tickets/AOS-7/transition": (init) => ({
        status: 200,
        body: { ...ticket, ...JSON.parse(String(init?.body)), version: 4 },
      }),
    });
    renderApp("/tickets/AOS-7");
    await userEvent.selectOptions(await screen.findByLabelText("Перевести в"), "s-done");
    expect(screen.getByLabelText("Исход")).toHaveValue("done");
    expect(within(screen.getByLabelText("Исход")).queryByRole("option", { name: "Отменено" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Перевести" }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/transition"))).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.path.endsWith("/transition"))?.init?.body))).toEqual({
      version: 3,
      statusId: "s-done",
      outcome: "done",
    });
    expect(screen.getByLabelText("Причина отмены")).toBeRequired();
  });
});

describe("space tickets", () => {
  test("a ticket opens by a click on any free part of its card", async () => {
    api({
      "GET /api/v1/tickets?spaceId=space-core&archived=exclude&sort=number": () => ({
        status: 200,
        body: {
          items: [
            {
              id: "t1",
              key: "AOS-7",
              numbers: ["1.2"],
              titleOnly: false,
              progress: null,
              coverage: 0,
              title: "Жаба",
              typeId: "type-story",
              statusId: "s-backlog",
              outcome: null,
              priority: "normal",
              assignees: [],
              blocked: false,
              archived: false,
              updatedAt: "2026-11-17T10:00:00.000Z",
            },
          ],
        },
      }),
    });
    renderApp("/spaces/core");
    const key = await screen.findByText("AOS-7");
    await userEvent.click(screen.getByText("без исполнителя"));
    expect(await screen.findByRole("heading", { name: "Задача" })).toBeInTheDocument();
    expect(key).not.toBeInTheDocument();
  });
});

describe("comments and actions (YT-07)", () => {
  const comment = {
    id: "c1",
    ticketId: "t1",
    author: person("u1", "Анна Тестова"),
    authorName: "Анна Тестова",
    body: "@ben глянь AOS-8 и AOS-99",
    createdAt: "2026-11-17T10:00:00.000Z",
    editedAt: null,
    deleted: false,
    mentions: {
      people: [{ login: "ben", id: "u2", name: "Ben Tester" }],
      tickets: [{ key: "AOS-8", title: "Звук", statusName: "Backlog" }],
    },
    createdTicket: { key: "AOS-9", title: "Звук прыжка", statusName: "Done", category: "done" },
    canEdit: true,
    canDelete: true,
  };
  const history = {
    items: [
      {
        id: 3,
        at: "2026-11-17T11:00:00.000Z",
        actor: person("u1", "Анна Тестова"),
        actorName: "Анна Тестова",
        source: "person",
        sourceDetail: null,
        field: "values.size",
        fieldLabel: "Размер",
        from: null,
        to: { raw: "m", text: "M" },
      },
      {
        id: 2,
        at: "2026-11-17T10:30:00.000Z",
        actor: null,
        actorName: null,
        source: "system",
        sourceDetail: "status scheme changed",
        field: "status",
        fieldLabel: null,
        from: { raw: {}, text: "Backlog" },
        to: { raw: {}, text: "Бэклог" },
      },
      {
        id: 1,
        at: "2026-11-17T10:00:00.000Z",
        actor: person("u1", "Анна Тестова"),
        actorName: "Анна Тестова",
        source: "person",
        sourceDetail: null,
        field: "priority",
        fieldLabel: null,
        from: { raw: "normal", text: "normal" },
        to: { raw: "high", text: "high" },
      },
    ],
  };

  test("mentions of a person and a ticket lead by link; unknown keys stay text; the task shows its status", async () => {
    api({ "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [comment] } }) });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByRole("tab", { name: "Комментарии · 1" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "@Ben Tester" })).toHaveAttribute("href", "/people/u2");
    expect(screen.getByRole("link", { name: "AOS-8" })).toHaveAttribute("href", "/tickets/AOS-8");
    expect(screen.queryByRole("link", { name: "AOS-99" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Задача AOS-9" })).toHaveAttribute("href", "/tickets/AOS-9");
    expect(screen.getByRole("link", { name: "Задача AOS-9" }).closest("p")).toHaveTextContent("Звук прыжка Done");
  });

  test("the Actions tab shows who, when, and from → to in plain words", async () => {
    api({
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/tickets/AOS-7/history": () => ({ status: 200, body: history }),
    });
    renderApp("/tickets/AOS-7");
    await userEvent.click(await screen.findByRole("tab", { name: "Действия" }));
    expect(await screen.findByText("Размер: пусто → M")).toBeInTheDocument();
    expect(screen.getByText("Статус: Backlog → Бэклог")).toBeInTheDocument();
    expect(screen.getByText("Приоритет: обычный → высокий")).toBeInTheDocument();
    expect(screen.getByText(/· система$/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Последовательность статусов (CSV)" })).toHaveAttribute(
      "href",
      "/api/v1/tickets/AOS-7/status-history?format=csv",
    );
  });

  test("typing @ suggests people by login and inserts the mention", async () => {
    const calls = api({
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/people": () => ({
        status: 200,
        body: { items: [{ id: "u2", name: "Ben Tester", email: "ben@x.test", catalog: { username: "ben" } }] },
      }),
      "POST /api/v1/tickets/AOS-7/comments": (init) => ({
        status: 201,
        body: { ...comment, body: JSON.parse(String(init?.body)).body },
      }),
    });
    renderApp("/tickets/AOS-7");
    const field = await screen.findByLabelText("Комментарий");
    await userEvent.type(field, "Привет, @be");
    await userEvent.click(await screen.findByRole("button", { name: /@ben/ }));
    expect(field).toHaveValue("Привет, @ben ");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "POST")?.init?.body))).toEqual({
      body: "Привет, @ben ",
    });
  });
});

describe("rights, visibility, hierarchy and rollups in the card (YT-08…YT-10)", () => {
  test("without the rights of the team the card is read-only: no edit buttons, status and CSV are not offered", async () => {
    const readOnly = {
      ...ticket,
      permissions: {
        ...ticket.permissions,
        edit: false,
        status: false,
        assign: false,
        dates: false,
        move: false,
        export: false,
      },
    };
    api({
      "GET /api/v1/tickets/AOS-7": () => ({ status: 200, body: readOnly }),
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/tickets/AOS-7/history": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByText(/Вы можете смотреть и комментировать/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByLabelText("Перевести в")).toBeNull();
    expect(await screen.findByText(/Статус меняет команда тикета/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Действия" }));
    expect(screen.queryByRole("link", { name: "Последовательность статусов (CSV)" })).toBeNull();
  });

  test("title only: the title and progress are shown, the content is not", async () => {
    api({
      "GET /api/v1/tickets/AOS-7": () => ({
        status: 403,
        body: {
          status: 403,
          code: "ticket_title_only",
          title: "x",
          type: "x",
          requestId: "r",
          ticket: {
            key: "AOS-7",
            title: "Секретный эпик",
            typeId: "type-story",
            progress: { done: 1, total: 4, percent: 25 },
          },
        },
      }),
    });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByRole("heading", { level: 1, name: "Секретный эпик" })).toBeInTheDocument();
    expect(screen.getByText("Видно только название")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.queryByText("Описание")).toBeNull();
  });

  test("links: parents with coverage, an unavailable child without key or title, «+ child» in one line", async () => {
    const linked = {
      ...ticket,
      checklist: [
        { id: "c1", text: "Свой пункт", done: true },
        { id: "c2", text: "Скрипт", done: false, childKey: "AOS-31" },
      ],
      relations: {
        links: [],
        traces: [],
        coverage: 2,
        parents: [
          {
            available: true,
            key: "AOS-1",
            title: "Боевая система",
            typeId: "type-story",
            spaceId: "space-core",
            spaceName: "Core",
            statusName: "In Progress",
            category: "in_progress",
            outcome: null,
            assignees: [],
            progress: null,
            titleOnly: false,
          },
        ],
        children: [
          {
            available: true,
            key: "AOS-31",
            title: "Скрипт смены камеры",
            typeId: "type-story",
            spaceId: "space-core",
            spaceName: "Core",
            statusName: "Backlog",
            category: "queue",
            outcome: null,
            assignees: [],
            progress: null,
            titleOnly: false,
            inChecklist: true,
          },
          { available: false },
        ],
      },
      rollup: { ...ticket.rollup, progress: { done: 1, total: 3, percent: 33 }, closeSuggested: true },
    };
    const calls = api({
      "GET /api/v1/tickets/AOS-7": () => ({ status: 200, body: linked }),
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "POST /api/v1/tickets": (init) => ({
        status: 201,
        body: { ...ticket, key: "AOS-40", ...JSON.parse(String(init?.body)) },
      }),
    });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByText("охват: 2")).toBeInTheDocument();
    expect(screen.getByText("Связанный тикет недоступен")).toBeInTheDocument();
    expect(screen.getByText("1 из 3")).toBeInTheDocument();
    expect(screen.getByText(/Все дети закрыты — закрыть тикет/)).toBeInTheDocument();
    expect(screen.getByText("отметится сам, когда AOS-31 закроют")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Пункт-ребёнок/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "+ ребёнок" }));
    const line = screen.getByRole("textbox", { name: "+ ребёнок" });
    await userEvent.type(line, "Звук смены{Enter}");
    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.path === "/api/v1/tickets")).toBe(true),
    );
    expect(
      JSON.parse(String(calls.find((call) => call.path === "/api/v1/tickets" && call.method === "POST")?.init?.body)),
    ).toEqual({
      title: "Звук смены",
      typeId: "type-story",
      spaceId: "space-core",
      parentKey: "AOS-7",
    });
  });
});

describe("tree (YT-09)", () => {
  test("a shared ticket appears under both parents, the second time as «same ticket»; an unavailable node has no key", async () => {
    api({
      "GET /api/v1/tree?spaceId=space-core": () => ({
        status: 200,
        body: {
          roots: ["e1", "e2"],
          children: { e1: ["s1"], e2: ["s1", "hidden-1"] },
          nodes: {
            e1: {
              id: "e1",
              available: true,
              key: "AOS-1",
              title: "Боевая система",
              typeId: "type-story",
              spaceId: "space-core",
              statusName: "Backlog",
              category: "queue",
              parentCount: 0,
              coverage: 0,
              progress: null,
            },
            e2: {
              id: "e2",
              available: true,
              key: "AOS-2",
              title: "Интерфейс боя",
              typeId: "type-story",
              spaceId: "space-core",
              statusName: "Backlog",
              category: "queue",
              parentCount: 0,
              coverage: 0,
              progress: null,
            },
            s1: {
              id: "s1",
              available: true,
              key: "AOS-3",
              title: "Смена героя",
              typeId: "type-story",
              spaceId: "space-core",
              statusName: "Backlog",
              category: "queue",
              parentCount: 2,
              coverage: 0,
              progress: null,
            },
            "hidden-1": { id: "hidden-1", available: false, parentCount: 1 },
          },
        },
      }),
    });
    renderApp("/spaces/core/tree");
    expect(await screen.findAllByRole("link", { name: "AOS-3" })).toHaveLength(2);
    expect(screen.getAllByText("тот же тикет")).toHaveLength(1);
    expect(screen.getByText("Связанный тикет недоступен")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("checkbox", { name: "Выбрать AOS-3" })[0] as HTMLElement);
    expect(screen.getByText("Выбрано: 1")).toBeInTheDocument();
  });
});

describe("flow number (YT-11)", () => {
  test("the card shows a number per path next to the key; the history explains a shift", async () => {
    api({
      "GET /api/v1/tickets/AOS-7": () => ({
        status: 200,
        body: {
          ...ticket,
          numbers: [
            { number: "1.3", parentKey: "AOS-1" },
            { number: "2.1", parentKey: "AOS-2" },
          ],
        },
      }),
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/tickets/AOS-7/history": () => ({
        status: 200,
        body: {
          items: [
            {
              id: 9,
              at: "2026-11-18T10:00:00.000Z",
              actor: null,
              actorName: null,
              source: "system",
              sourceDetail: "number:inserted:AOS-12",
              field: "number",
              fieldLabel: null,
              from: { raw: ["1.3"], text: "1.3" },
              to: { raw: ["1.4"], text: "1.4" },
            },
          ],
        },
      }),
    });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByText("№ 1.3 в AOS-1")).toBeInTheDocument();
    expect(screen.getByText("№ 2.1 в AOS-2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Действия" }));
    expect(await screen.findByText("Номер 1.3 → 1.4, вставлен AOS-12")).toBeInTheDocument();
    expect(screen.getByText(/система · пересчёт номеров/)).toBeInTheDocument();
  });
});

describe("links and the links block (YT-12)", () => {
  const related = (key: string, title: string) => ({
    available: true,
    key,
    title,
    typeId: "type-story",
    spaceId: "space-core",
    spaceName: "Core",
    statusName: "Backlog",
    category: "queue",
    outcome: null,
    assignees: [],
    progress: null,
    titleOnly: false,
  });
  const linkTypes = {
    items: [
      {
        id: "link-relates",
        key: "relates",
        name: "Связан с",
        inverseName: "Связан с",
        symmetric: true,
        system: true,
        links: 0,
      },
      {
        id: "link-blocks",
        key: "blocks",
        name: "Блокирует",
        inverseName: "Заблокирован",
        symmetric: false,
        system: true,
        links: 1,
      },
    ],
  };

  test("a link is seen with its side's label and changes type in one action; an unavailable one has no key", async () => {
    const calls = api({
      "GET /api/v1/tickets/AOS-7": () => ({
        status: 200,
        body: {
          ...ticket,
          relations: {
            ...ticket.relations,
            links: [
              {
                id: "l1",
                typeId: "link-blocks",
                typeKey: "blocks",
                direction: "out",
                label: "Блокирует",
                ticket: related("AOS-9", "Комбо"),
              },
              {
                id: "l2",
                typeId: "link-relates",
                typeKey: "relates",
                direction: "out",
                label: "Связан с",
                ticket: { available: false },
              },
            ],
          },
        },
      }),
      "GET /api/v1/link-types": () => ({ status: 200, body: linkTypes }),
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "PATCH /api/v1/links/l1": () => ({ status: 200, body: ticket }),
    });
    renderApp("/tickets/AOS-7");
    const group = await screen.findByRole("region", { name: "Блокирует" });
    expect(within(group).getByRole("link", { name: "AOS-9" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Связан с" })).toHaveTextContent("Связанный тикет недоступен");
    await userEvent.selectOptions(within(group).getByRole("combobox", { name: "Тип связи" }), "link-relates:out");
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "PATCH")?.init?.body))).toEqual({
      typeId: "link-relates",
      direction: "out",
      fromKey: "AOS-7",
    });
  });

  test("YourWiki documents: live title and access, «no access» with «Request», «in trash», «Open original»", async () => {
    const doc = (patch: object) => ({
      state: "available",
      access: "read",
      source: { type: "google", name: "Google Диск" },
      wikiUrl: "http://wiki/documents/gdd",
      originalUrl: null,
      canRequestAccess: false,
      requested: false,
      ...patch,
    });
    const calls = api({
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/tickets/AOS-7/web-links": () => ({
        status: 200,
        body: {
          items: [
            {
              id: "w1",
              kind: "yourwiki",
              url: "http://wiki/documents/gdd",
              title: "ГДД: боевая система",
              document: doc({ originalUrl: "https://docs.google.com/document/d/x" }),
              warning: null,
              createdAt: "2026-11-18T00:00:00Z",
            },
            {
              id: "w2",
              kind: "yourwiki",
              url: "http://wiki/documents/tech",
              title: null,
              document: doc({
                state: "unavailable",
                access: "none",
                wikiUrl: null,
                canRequestAccess: true,
                source: null,
              }),
              warning: null,
              createdAt: "2026-11-18T00:00:00Z",
            },
            {
              id: "w3",
              kind: "yourwiki",
              url: "http://wiki/documents/old",
              title: "Старый ГДД",
              document: doc({ state: "trashed", access: "none" }),
              warning: null,
              createdAt: "2026-11-18T00:00:00Z",
            },
            {
              id: "w4",
              kind: "web",
              url: "https://example.com/ref",
              title: "Референс: переключение героя",
              document: null,
              warning: null,
              createdAt: "2026-11-18T00:00:00Z",
            },
          ],
        },
      }),
      "POST /api/v1/web-links/w2/request-access": () => ({ status: 200, body: { items: [] } }),
    });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByRole("link", { name: "ГДД: боевая система" })).toHaveAttribute(
      "href",
      "http://wiki/documents/gdd",
    );
    expect(screen.getByText("доступ есть")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Открыть оригинал" })).toHaveAttribute(
      "href",
      "https://docs.google.com/document/d/x",
    );
    expect(screen.getByText("нет доступа")).toBeInTheDocument();
    expect(screen.getByText("в корзине")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Референс: переключение героя" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Открыть оригинал" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Запросить" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/v1/web-links/w2/request-access")).toBe(true));
  });
});

describe("attachments (YT-13)", () => {
  const settings = {
    maxFileBytes: 1024,
    maxTicketBytes: 4096,
    maxSpaceBytes: 1048576,
    allowed: ["png", "mp4", "pdf"],
    updatedAt: "2026-11-19T00:00:00Z",
  };
  const attachment = (id: string, name: string, kind: string, group: string) => ({
    id,
    name,
    kind,
    group,
    mime: "x",
    size: 512,
    url: `/api/v1/attachments/${id}`,
    uploadedBy: { id: "u1", name: "Анна Тестова" },
    createdAt: "2026-11-19T00:00:00Z",
    canDelete: true,
  });

  test("previews images and videos, plays a video inserted into the description, refuses a big file before uploading", async () => {
    const calls = api({
      "GET /api/v1/tickets/AOS-7": () => ({
        status: 200,
        body: { ...ticket, description: "Запись бага:\n\n![запись.mp4](/api/v1/attachments/v1)" },
      }),
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/attachment-settings": () => ({ status: 200, body: settings }),
      "GET /api/v1/tickets/AOS-7/attachments": () => ({
        status: 200,
        body: {
          items: [attachment("i1", "скриншот.png", "png", "image"), attachment("v1", "запись.mp4", "mp4", "video")],
        },
      }),
    });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByRole("img", { name: "скриншот.png" })).toHaveAttribute("src", "/api/v1/attachments/i1");
    // Видео есть и в блоке вложений, и в описании.
    await waitFor(() => expect(document.querySelectorAll('video[src="/api/v1/attachments/v1"]')).toHaveLength(2));

    const big = new File([new Uint8Array(2048)], "огромное.mp4", { type: "video/mp4" });
    await userEvent.upload(screen.getByLabelText("Прикрепить файл"), big);
    expect(await screen.findByText(/«огромное\.mp4» больше 1 КБ/)).toBeInTheDocument();
    const exe = new File([new Uint8Array(10)], "setup.exe");
    await userEvent.upload(screen.getByLabelText("Прикрепить файл"), exe, { applyAccept: false });
    expect(await screen.findByText(/файлы \.exe прикреплять нельзя/)).toBeInTheDocument();
    // Ничего не ушло на сервер: отказ — до начала загрузки.
    expect(calls.some((call) => call.path.includes("/uploads"))).toBe(false);
  });
});

describe("trash and the parent trace (YT-14)", () => {
  const trashed = { batchId: "b1", deleted: [{ key: "AOS-7", title: "Прототип боя" }], children: [], notified: [] };

  test("deleting a parent asks about the children with «keep» by default; then the space opens with «Undo»", async () => {
    let attempt = 0;
    const calls = api({
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "GET /api/v1/tickets?spaceId=space-core&archived=exclude&sort=number": () => ({
        status: 200,
        body: { items: [] },
      }),
      "POST /api/v1/tickets/trash": () => {
        attempt += 1;
        return attempt === 1
          ? {
              status: 409,
              body: {
                status: 409,
                code: "children_choice_required",
                title: "x",
                type: "x",
                requestId: "r",
                choice: { children: [{ key: "AOS-31", title: "Скрипт смены камеры" }], hasGrandparents: false },
              },
            }
          : { status: 200, body: { ...trashed, children: [{ key: "AOS-31", title: "Скрипт смены камеры" }] } };
      },
      "POST /api/v1/trash/restore": () => ({
        status: 200,
        body: { restored: [{ key: "AOS-7", title: "Прототип боя" }], skipped: [] },
      }),
    });
    renderApp("/tickets/AOS-7");
    await userEvent.click(await screen.findByRole("button", { name: "В корзину" }));
    const dialog = await screen.findByRole("dialog", { name: "Что сделать с детьми?" });
    expect(within(dialog).getByRole("radio", { name: /Оставить без этой связи/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Привязать к родителю удаляемого/ })).toBeDisabled();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(4);
    await userEvent.click(within(dialog).getByRole("button", { name: "В корзину" }));

    const toast = await screen.findByText(/AOS-7 «Прототип боя» в корзине/);
    expect(toast).toBeInTheDocument();
    const body = JSON.parse(String(calls.filter((call) => call.path === "/api/v1/tickets/trash").at(-1)?.init?.body));
    expect(body).toEqual({ keys: ["AOS-7"], children: "keep" });
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(await screen.findByText("Восстановлено: AOS-7")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/api/v1/trash/restore")?.init?.body).toBe('{"batchId":"b1"}');
  });

  test("a child shows the parent trace and relinks every former child in one action", async () => {
    const calls = api({
      "GET /api/v1/tickets/AOS-7": () => ({
        status: 200,
        body: {
          ...ticket,
          relations: {
            ...ticketExtras.relations,
            traces: [
              {
                id: "tr1",
                parentKey: "AOS-199",
                parentTitle: "Прототип боя",
                parentState: "purged",
                removedAt: "2026-11-02T10:00:00.000Z",
                removedBy: null,
                others: 6,
              },
            ],
          },
        },
      }),
      "GET /api/v1/tickets/AOS-7/comments": () => ({ status: 200, body: { items: [] } }),
      "POST /api/v1/traces/relink": () => ({
        status: 200,
        body: { relinked: Array.from({ length: 7 }, (_, index) => ({ key: `AOS-${index}`, title: "x" })), skipped: [] },
      }),
    });
    renderApp("/tickets/AOS-7");
    const trace = await screen.findByRole("region", { name: "След родителя" });
    expect(within(trace).getByText(/AOS-199 «Прототип боя» · удалён окончательно/)).toBeInTheDocument();
    expect(within(trace).getByText(/ещё тикетов с этим следом: 6/)).toBeInTheDocument();
    expect(within(trace).getByRole("link", { name: "parentTrace(AOS-199)" })).toHaveAttribute(
      "href",
      "/spaces/core?q=parentTrace(AOS-199)",
    );
    await userEvent.click(within(trace).getByRole("button", { name: "Связать заново" }));
    await userEvent.type(within(trace).getByLabelText(/Новый родитель/), "aos-418");
    await userEvent.click(within(trace).getByRole("button", { name: "Связать всех (7)" }));
    expect(await screen.findByText("Связано заново: 7.")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/api/v1/traces/relink")?.init?.body).toBe(
      '{"parentKey":"AOS-199","toKey":"AOS-418"}',
    );
  });

  test("a link to a deleted ticket says it is in the trash, who deleted it, and offers to restore", async () => {
    api({
      "GET /api/v1/tickets/AOS-7": () => ({
        status: 404,
        body: {
          status: 404,
          code: "ticket_in_trash",
          title: "x",
          type: "x",
          requestId: "r",
          ticket: {
            key: "AOS-7",
            title: "Прототип боя",
            deletedAt: "2026-11-02T10:00:00.000Z",
            deletedBy: { name: "Бен Тестовый" },
            canRestore: true,
          },
        },
      }),
    });
    renderApp("/tickets/AOS-7");
    expect(await screen.findByText("в корзине")).toBeInTheDocument();
    expect(screen.getByText(/Бен Тестовый/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Восстановить" })).toBeInTheDocument();
  });
});
