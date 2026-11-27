import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_BOARD_PREFS,
  starterZones,
  type BoardCard,
  type BoardStatusOption,
  type BoardView,
} from "@yourtask/contracts";
import { meFixture, mockApi, problem, renderApp } from "./utils";

/** YT-16: доска — зоны, детализация, перенос с выбором статуса, причины отказа, просрочка (R-2.18, R-2.19, R-3.3). */
const st = (id: string, name: string, category: BoardStatusOption["category"] = "in_progress", waiting = false) => ({
  id,
  name,
  category,
  waiting,
  outcomes: category === "done" ? ["done", "cancelled"] : [],
});
const story = [
  st("s-backlog", "Backlog", "queue"),
  st("s-discovery", "Discovery"),
  st("s-analysis", "Analysis"),
  st("s-creation", "Creation"),
  st("s-creation-done", "Creation Done", "in_progress", true),
  st("s-implementation", "Implementation"),
  st("s-test", "Test"),
  st("s-done", "Done", "done"),
];
const bug = [
  st("b-backlog", "Backlog", "queue"),
  st("b-implementation", "Implementation"),
  st("b-review", "Review"),
  st("b-test", "Test"),
  st("b-done", "Done", "done"),
];

const card = (key: string, title: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  id: `id-${key}`,
  key,
  title,
  typeId: "type-story",
  spaceId: "space-production",
  statusId: "s-backlog",
  statusName: "Backlog",
  category: "queue",
  waiting: false,
  outcome: null,
  scheme: "type-story:space-production",
  version: 3,
  priority: "normal",
  assignees: [{ id: "u1", name: "Анна Тестова", email: "anna@yourspace.test", deactivated: false }],
  numbers: ["1.2"],
  due: null,
  overdue: false,
  team: { id: "t-frogs", name: "Жабы" },
  streams: [{ id: "g-gd", name: "ГД" }],
  parents: [{ id: "id-AOS-1", key: "AOS-1", title: "Боевая система" }],
  progress: null,
  blocked: false,
  tags: [],
  dims: {},
  rank: null,
  canMove: true,
  ...extra,
});

function boardView(cards: BoardCard[], prefs = DEFAULT_BOARD_PREFS): BoardView & { overflow: number } {
  return {
    board: {
      id: "b-frogs",
      name: "Жабы",
      kind: "custom",
      owner: { kind: "space", spaceId: "space-production", spaceName: "Производство", spaceSlug: "production" },
      query: "team = Frogs or involvedTeams = Frogs",
      canEdit: true,
      lanes: "parent",
      sort: "due",
      doneDays: 14,
      chips: ["stream", "type"],
      tqlLanes: [],
      tqlChips: [],
      zones: starterZones().map((zone) => (zone.id === "Production" ? { ...zone, wipLimit: 1 } : zone)),
    },
    prefs,
    cards,
    schemes: { "type-story:space-production": story, "type-bug:space-production": bug },
    hiddenDone: 2,
    dimensions: [],
    laneHits: {},
    chipHits: {},
    refine: null,
    overflow: 0,
    tookMs: 12,
  };
}

const types = [
  { id: "type-story", key: "story", name: "Стори", color: "#16a34a", icon: "book-open", outcomes: [] },
  {
    id: "type-bug",
    key: "bug",
    name: "Баг",
    color: "#dc2626",
    icon: "bug",
    outcomes: [{ key: "fixed", label: "Исправлено" }],
  },
];

function api(view: ReturnType<typeof boardView>, extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
    "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/notifications": () => ({ status: 200, body: { items: [], unread: 0 } }),
    "GET /api/v1/products": () => ({ status: 200, body: { products: [] } }),
    "GET /api/v1/boards": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/boards/b-frogs": () => ({ status: 200, body: view }),
    "GET /api/v1/ticket-types": () => ({ status: 200, body: { items: types } }),
    "GET /api/v1/fields": () => ({ status: 200, body: { items: [{ key: "due_date", name: "Срок" }] } }),
    "PUT /api/v1/boards/b-frogs/prefs": (init) => ({ status: 200, body: JSON.parse(String(init?.body)) }),
    ...extra,
  });
}

const transfer = () => ({ setData() {}, getData: () => "", effectAllowed: "", dropEffect: "" });
async function drag(key: string, columnLabel: string) {
  const source = await screen.findByRole("article", { name: new RegExp(`^${key} `) });
  const row = source.closest(".board-row") as HTMLElement;
  const target = within(row).getByRole("group", { name: columnLabel });
  const dataTransfer = transfer();
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer, clientX: 100, clientY: 100 });
}

describe("board", () => {
  test("zone header: detail 1 / 2 / 3, collapsing a zone; the choice is saved for me only", async () => {
    const calls = api(boardView([card("AOS-5", "Комбо при переключении героя")]));
    renderApp("/boards/b-frogs");
    await screen.findByRole("heading", { name: "Жабы", level: 1 });
    const headers = () => screen.getAllByRole("columnheader").map((cell) => cell.querySelector("strong")?.textContent);
    expect(headers()).toEqual(
      expect.arrayContaining(["Discovery", "Delivery", "Done", "Бэклог", "Производство", "Тест"]),
    );
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    await waitFor(() => expect(headers()).toEqual(["Discovery", "Delivery", "Done"]));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    await waitFor(() => expect(headers()).toContain("Creation Done"));
    // Свернуть «Delivery» обратно в одну колонку.
    fireEvent.click(screen.getByRole("button", { name: "Свернуть зону «Delivery»" }));
    await waitFor(() => expect(headers()).not.toContain("Производство"));
    const saved = calls.filter((call) => call.method === "PUT" && call.path === "/api/v1/boards/b-frogs/prefs");
    expect(JSON.parse(String(saved.at(-1)?.init?.body))).toMatchObject({ detail: 3, collapsed: ["Delivery"] });
  });

  test("a story dropped into «Production» asks Creation or Implementation, then moves with the chosen status", async () => {
    let moved: Record<string, unknown> | null = null;
    api(boardView([card("AOS-5", "Комбо при переключении героя", { due: "2030-01-10" })]), {
      "POST /api/v1/boards/b-frogs/move": (init) => {
        moved = JSON.parse(String(init?.body));
        return { status: 200, body: { ticket: {} } };
      },
    });
    renderApp("/boards/b-frogs");
    await drag("AOS-5", "Производство");
    const chooser = await screen.findByRole("dialog", { name: "Какой статус в «Производство»?" });
    const options = within(chooser)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(options).toEqual(expect.arrayContaining(["Creation", "Implementation", "Creation Doneожидание"]));
    fireEvent.click(within(chooser).getByRole("button", { name: "Creation" }));
    await waitFor(() =>
      expect(moved).toMatchObject({ key: "AOS-5", version: 3, zoneId: "Production", statusId: "s-creation" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a bug cannot go to «Elaboration»: the reason is explained, nothing is sent", async () => {
    const calls = api(
      boardView([
        card("AOS-432", "Камера дёргается", {
          typeId: "type-bug",
          scheme: "type-bug:space-production",
          statusId: "b-backlog",
        }),
      ]),
    );
    renderApp("/boards/b-frogs");
    await drag("AOS-432", "Проработка");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("«Баг» нельзя перенести в «Проработка»: в схеме этого типа нет статусов зоны");
    expect(alert).toHaveTextContent("Тип проходит эту зону насквозь");
    expect(calls.some((call) => call.path.endsWith("/move"))).toBe(false);
  });

  test("entry requirements: the refusal says what to fill in, in the same words as the ticket card", async () => {
    api(boardView([card("AOS-5", "Комбо")]), {
      "POST /api/v1/boards/b-frogs/move": () => ({
        status: 422,
        body: {
          ...problem(422, "transition_blocked").body,
          errors: [{ field: "values.due_date", message: "fill in the field: Срок" }],
        },
      }),
    });
    renderApp("/boards/b-frogs");
    await drag("AOS-5", "Тест");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("AOS-5 не перенесён в «Test»");
    expect(alert).toHaveTextContent("Срок");
    expect(within(alert).getByRole("link", { name: "Открыть тикет" })).toHaveAttribute("href", "/tickets/AOS-5");
  });

  test("a status without a zone lands in «Not mapped» with a warning; overdue is shown by text and icon, not by colour only", async () => {
    api(
      boardView([
        card("AOS-440", "Ревью камеры", {
          typeId: "type-bug",
          scheme: "type-bug:space-production",
          statusId: "b-review",
          statusName: "Review",
          category: "in_progress",
        }),
        card("AOS-426", "HUD: портреты партии", { due: "2026-01-02", overdue: true }),
      ]),
    );
    renderApp("/boards/b-frogs");
    const status = await screen.findByText(/Статус без зоны: Review/);
    expect(status).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").some((cell) => cell.textContent?.startsWith("Не сопоставлено"))).toBe(
      true,
    );
    expect(screen.getByRole("group", { name: "Не сопоставлено" })).toHaveTextContent("Ревью камеры");
    const late = screen.getByRole("article", { name: /^AOS-426 / });
    expect(within(late).getByText("просрочено")).toBeInTheDocument();
    expect(screen.getByText(/Скрыто завершённых старше 14 дн.: 2/)).toBeInTheDocument();
  });

  test("WIP over the zone limit: «n / limit» and the words «WIP exceeded»; a shared ticket in two lanes is marked and counted once", async () => {
    const shared = card("AOS-418", "Переключение персонажа", {
      statusId: "s-creation",
      statusName: "Creation",
      category: "in_progress",
      parents: [
        { id: "id-AOS-201", key: "AOS-201", title: "Боевая система" },
        { id: "id-AOS-230", key: "AOS-230", title: "Интерфейс боя" },
      ],
    });
    const other = card("AOS-431", "Скрипт смены камеры", {
      statusId: "s-creation",
      statusName: "Creation",
      category: "in_progress",
    });
    api(boardView([shared, other]));
    renderApp("/boards/b-frogs");
    const production = (await screen.findAllByRole("columnheader")).find((cell) =>
      cell.textContent?.startsWith("Производство"),
    ) as HTMLElement;
    expect(production).toHaveTextContent("2 / 1");
    expect(production).toHaveTextContent("WIP превышен");
    const copies = screen.getAllByRole("article", { name: /^AOS-418 / });
    expect(copies).toHaveLength(2);
    expect(within(copies[1] as HTMLElement).getByText(/Тот же тикет/)).toBeInTheDocument();
  });

  test("density and chips: compact hides the tags row; a switched-off chip hides cards, the board stays", async () => {
    api(
      boardView([
        card("AOS-5", "Стори Жаб"),
        card("AOS-6", "Баг Жаб", { typeId: "type-bug", scheme: "type-bug:space-production", statusId: "b-backlog" }),
      ]),
    );
    renderApp("/boards/b-frogs");
    await screen.findByRole("article", { name: /^AOS-6 / });
    await screen.findByRole("button", { name: "Баг" });
    fireEvent.click(within(screen.getByRole("group", { name: "Типы:" })).getByRole("button", { name: "Баг" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: /^AOS-6 / })).toBeNull());
    expect(screen.getByRole("article", { name: /^AOS-5 / })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Плотность:"), { target: { value: "compact" } });
    await waitFor(() => expect(screen.getByRole("article", { name: /^AOS-5 / })).toHaveClass("board-card--compact"));
  });

  test("keyboard: «Move» opens the choice of every allowed status, arrows walk it, Esc closes and returns focus", async () => {
    api(boardView([card("AOS-5", "Комбо")]));
    renderApp("/boards/b-frogs");
    const button = await screen.findByRole("button", { name: "Переместить AOS-5" });
    button.focus();
    fireEvent.click(button);
    const chooser = await screen.findByRole("dialog", { name: "Куда перенести AOS-5?" });
    const options = within(chooser)
      .getAllByRole("button")
      .filter((item) => item.hasAttribute("data-choice"));
    expect(options.map((item) => item.textContent)).toEqual(expect.arrayContaining(["Creation", "Test"]));
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Переместить AOS-5" }));
  });
});

/** YT-17: дорожки по любому разрезу, чипы, ссылка с состоянием (R-2.18, R-2.14). */
describe("lanes, chips and the board link", () => {
  const frogs = { id: "t-frogs", name: "Жабы" };
  const pigs = { id: "t-pigs", name: "Хрюшки" };
  const leadCards = () => [
    card("AOS-436", "Баланс урона партии", { team: frogs }),
    card("AOS-470", "Лут сундуков в локации", { team: pigs }),
    card("AOS-125", "Правила дружбы напарников", { team: null }),
  ];
  const lead = (cards: BoardCard[], extra: Partial<BoardView["board"]> = {}, view: Partial<BoardView> = {}) => {
    const base = boardView(cards);
    return {
      ...base,
      ...view,
      board: {
        ...base.board,
        name: "Лид ГД",
        lanes: "team" as const,
        chips: ["team" as const, "type" as const],
        ...extra,
      },
    };
  };
  const laneTitles = () =>
    screen.queryAllByRole("heading", { level: 2 }).map((heading) => heading.querySelector("button")?.textContent);

  test("the GD lead sees lanes for every team and «No feature team», and switches «Frogs» off without leaving", async () => {
    const calls = api(lead(leadCards()));
    renderApp("/boards/b-frogs");
    await screen.findByRole("article", { name: /^AOS-436 / });
    expect(laneTitles()).toEqual(["Жабы", "Хрюшки", "Без фичекоманды"]);
    const teams = screen.getByRole("group", { name: "Команды:" });
    expect(within(teams).getByRole("button", { name: "Без значения" })).toBeInTheDocument();
    fireEvent.click(within(teams).getByRole("button", { name: "Жабы" }));
    await waitFor(() => expect(laneTitles()).toEqual(["Хрюшки", "Без фичекоманды"]));
    expect(within(teams).getByRole("button", { name: "Жабы" })).toHaveAttribute("aria-pressed", "false");
    // Состояние чипа — личное: ушло на сервер и останется после перезагрузки.
    const saved = calls.filter((call) => call.method === "PUT" && call.path.endsWith("/prefs")).at(-1);
    expect(JSON.parse(String(saved?.init?.body)).chipsOff).toEqual(["team:t-frogs"]);
    // «Без значения» скрывает тикеты без команды.
    fireEvent.click(within(teams).getByRole("button", { name: "Без значения" }));
    await waitFor(() => expect(laneTitles()).toEqual(["Хрюшки"]));
  });

  test("the chip state comes back after a reload from my saved settings", async () => {
    api(lead(leadCards(), {}, { prefs: { ...DEFAULT_BOARD_PREFS, chipsOff: ["team:t-frogs"] } }));
    renderApp("/boards/b-frogs");
    await screen.findByRole("article", { name: /^AOS-470 / });
    expect(screen.queryByRole("article", { name: /^AOS-436 / })).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "Команды:" })).getByRole("button", { name: "Жабы" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  test("a ticket with two parents stands in two lanes; the column counter counts it once", async () => {
    const shared = card("AOS-418", "Переключение персонажа", {
      statusId: "s-creation",
      statusName: "Creation",
      category: "in_progress",
      parents: [
        { id: "p1", key: "AOS-201", title: "Боевая система" },
        { id: "p2", key: "AOS-230", title: "Интерфейс боя" },
      ],
    });
    const view = boardView([shared]);
    view.board.zones = view.board.zones.map((zone) => ({ ...zone, wipLimit: null }));
    api(view);
    renderApp("/boards/b-frogs");
    await screen.findAllByRole("article", { name: /^AOS-418 / });
    expect(screen.getAllByRole("article", { name: /^AOS-418 / })).toHaveLength(2);
    const production = screen
      .getAllByRole("columnheader")
      .find((cell) => cell.textContent?.startsWith("Производство")) as HTMLElement;
    expect(production.querySelector(".board-zone__count")).toHaveTextContent("1");
    expect(screen.getByText(/Тот же тикет/)).toBeInTheDocument();
  });

  test("the urgent lane «priority = Urgent» stays on top and takes its cards out of the team lanes", async () => {
    api(
      lead(
        leadCards(),
        { tqlLanes: [{ id: "urgent", name: "Срочно", query: "priority = Urgent" }] },
        { laneHits: { urgent: ["id-AOS-470"] } },
      ),
    );
    renderApp("/boards/b-frogs");
    await screen.findByRole("article", { name: /^AOS-470 / });
    expect(laneTitles()).toEqual(["Срочно", "Жабы", "Без фичекоманды"]);
    expect(within(screen.getByRole("region", { name: "Срочно" })).getByRole("article")).toHaveAccessibleName(
      /^AOS-470 /,
    );
  });

  test("a TQL chip «Only GD guild people» keeps only matching cards when switched on", async () => {
    api(
      lead(
        leadCards(),
        { tqlChips: [{ id: "gd-people", name: "Только люди колодца ГД", query: "assignee.guild = GD" }] },
        { chipHits: { "gd-people": ["id-AOS-436"] } },
      ),
    );
    renderApp("/boards/b-frogs");
    const chip = await screen.findByRole("button", { name: "Только люди колодца ГД" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("article")).toHaveLength(3);
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
  });

  test("a link opens the same filter, chips and lanes for a colleague, without touching their own settings", async () => {
    const calls = api(lead(leadCards()), {
      "GET /api/v1/boards/b-frogs?q=priority%20%3D%20Urgent": () => ({
        status: 200,
        body: { ...lead([leadCards()[1] as BoardCard]), refine: "priority = Urgent" },
      }),
    });
    renderApp("/boards/b-frogs?q=priority%20%3D%20Urgent&lanes=stream&off=type:type-bug&detail=1");
    await screen.findByRole("article", { name: /^AOS-470 / });
    expect(screen.getByLabelText("Дорожки:")).toHaveValue("stream");
    expect(screen.getByLabelText("Уточнить:")).toHaveValue("priority = Urgent");
    expect(screen.getByRole("button", { name: "1" })).toHaveAttribute("aria-pressed", "true");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  test("«Link to the board» copies the address with the current state", async () => {
    let copied = "";
    Object.assign(navigator, { clipboard: { writeText: async (text: string) => void (copied = text) } });
    api(lead(leadCards(), {}, { prefs: { ...DEFAULT_BOARD_PREFS, chipsOff: ["team:t-pigs"], lanes: "team" } }));
    renderApp("/boards/b-frogs");
    fireEvent.click(await screen.findByRole("button", { name: "Ссылка на доску" }));
    await screen.findByText(/Ссылка скопирована/);
    const link = new URL(copied);
    expect(link.searchParams.get("off")).toBe("team:t-pigs");
    expect(link.searchParams.get("lanes")).toBe("team");
    expect(link.searchParams.get("detail")).toBe("2");
  });

  test("two quick changes in a row keep both: a chip switched off and new lanes", async () => {
    const calls = api(lead(leadCards()));
    renderApp("/boards/b-frogs");
    await screen.findByRole("article", { name: /^AOS-436 / });
    fireEvent.click(within(screen.getByRole("group", { name: "Команды:" })).getByRole("button", { name: "Жабы" }));
    fireEvent.change(screen.getByLabelText("Дорожки:"), { target: { value: "stream" } });
    await waitFor(() => expect(screen.getByLabelText("Дорожки:")).toHaveValue("stream"));
    const saved = calls.filter((call) => call.method === "PUT" && call.path.endsWith("/prefs")).at(-1);
    expect(JSON.parse(String(saved?.init?.body))).toMatchObject({ chipsOff: ["team:t-frogs"], lanes: "stream" });
    expect(screen.queryByRole("article", { name: /^AOS-436 / })).toBeNull();
  });
});
