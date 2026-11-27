import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { meFixture, mockApi, renderApp } from "./utils";

/** YT-04: конструктор типов, шаблонов и оценок в интерфейсе. */
const tshirt = {
  id: "scale-tshirt",
  key: "tshirt",
  name: "Майки",
  kind: "ordinal",
  unit: null,
  system: true,
  values: ["XS", "S", "M", "L", "XL"].map((label) => ({ id: `t-${label}`, label })),
};
const days = { id: "scale-days", key: "days", name: "Дни", kind: "numeric", unit: "дн.", system: true, values: [] };
const converter = {
  spaceId: null,
  inherited: false,
  entries: [
    ["XS", 0.5, 1],
    ["S", 1, 2],
    ["M", 3, 5],
    ["L", 6, 10],
    ["XL", 11, 20],
  ].map(([label, minDays, maxDays]) => ({ scaleId: "scale-tshirt", valueId: `t-${label}`, minDays, maxDays })),
};
const fields = [
  {
    id: "f-size",
    key: "size",
    name: "Размер",
    kind: "estimate",
    options: [],
    multiple: false,
    scaleId: "scale-tshirt",
    dimensionId: null,
    system: true,
  },
  {
    id: "f-days",
    key: "estimate_days",
    name: "Оценка в днях",
    kind: "estimate",
    options: [],
    multiple: false,
    scaleId: "scale-days",
    dimensionId: null,
    system: true,
  },
];
const story = {
  id: "type-story",
  key: "story",
  name: "Стори",
  color: "#16A34A",
  icon: "book-open",
  fieldIds: ["f-size", "f-days"],
  rollups: { status: false, progress: "both", progressByEstimate: false, dates: false, estimates: true },
  allowedParentTypeIds: [],
  outcomes: [
    { key: "done", label: "Выполнено" },
    { key: "cancelled", label: "Отменено" },
  ],
  templates: [
    { id: "template-story", name: "Стори" },
    { id: "template-art", name: "Стори арта" },
  ],
  system: true,
};
const template = {
  id: "template-story",
  typeId: "type-story",
  name: "Стори",
  description: "## Задача\n\n## Критерии приёмки\n- \n\n<script>alert(1)</script>",
  checklist: ["Критерии приёмки проверены"],
  values: { size: "t-M", estimate_days: 6 },
  system: true,
};

function api(overrides: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru", "superadmin") }),
    "GET /api/v1/ticket-templates/template-story": () => ({ status: 200, body: template }),
    "GET /api/v1/ticket-types/type-story": () => ({ status: 200, body: story }),
    "GET /api/v1/ticket-types": () => ({ status: 200, body: { items: [story] } }),
    "GET /api/v1/fields": () => ({ status: 200, body: { items: fields } }),
    "GET /api/v1/estimate-scales": () => ({ status: 200, body: { items: [tshirt, days] } }),
    "GET /api/v1/estimate-converter": () => ({ status: 200, body: converter }),
    "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/people": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/dimensions": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/guilds": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/feature-teams": () => ({ status: 200, body: { items: [] } }),
    ...overrides,
  });
}

describe("ticket setup", () => {
  test("story preview: both estimates visible, M shows the converter guide, rollup follows the chosen scale", async () => {
    api();
    renderApp("/templates/template-story");
    const preview = await screen
      .findByRole("region", { name: "Предпросмотр" })
      .catch(() => screen.findByLabelText("Предпросмотр"));
    await waitFor(() => expect(within(preview).getByText("≈ 3–5 дн., ориентир", { exact: false })).toBeInTheDocument());
    expect(within(preview).getByText("M", { exact: false })).toBeInTheDocument();
    expect(within(preview).getByText("6 дн.")).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { name: "Критерии приёмки" })).toBeInTheDocument();
    expect(within(preview).getByText("Критерии приёмки проверены")).toBeInTheDocument();
    // Markdown не превращается в HTML: тег показан как текст.
    expect(within(preview).getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("script[src=''], .md-preview script")).toBeNull();

    // Два таких тикета: в майках M (3–5) + M (3–5) = 6–10 дней → L.
    expect(within(preview).getByRole("status")).toHaveTextContent("L · ≈ 6–10 дн., ориентир");
    await userEvent.selectOptions(within(preview).getByLabelText("Считать в шкале"), "scale-days");
    // В днях у тикета есть своя оценка — 6 дней, конвертер не нужен.
    expect(within(preview).getByRole("status")).toHaveTextContent("≈ 12 дн.");
    expect(within(preview).getByRole("status")).not.toHaveTextContent("приведено");
  });

  test("changing an estimate in the form updates the preview guide", async () => {
    api();
    renderApp("/templates/template-story");
    const size = await screen.findByLabelText("Размер");
    await userEvent.selectOptions(size, "t-S");
    expect(await screen.findByText("≈ 1–2 дн., ориентир", { exact: false })).toBeInTheDocument();
  });

  test("admin creates type «Веха»: name first, colour and icon by default, then the type page", async () => {
    const calls = api({
      "POST /api/v1/ticket-types": (init) => ({
        status: 201,
        body: {
          ...story,
          id: "type-milestone",
          key: "vekha",
          templates: [],
          system: false,
          ...JSON.parse(String(init?.body)),
        },
      }),
      "GET /api/v1/ticket-types/type-milestone": () => ({
        status: 200,
        body: {
          ...story,
          id: "type-milestone",
          name: "Веха",
          key: "vekha",
          color: "#0C5CAB",
          icon: "flag",
          templates: [],
          system: false,
        },
      }),
    });
    renderApp("/types");
    await userEvent.type(await screen.findByLabelText("Название"), "Веха");
    await userEvent.click(screen.getByRole("button", { name: "Новый тип" }));
    expect(await screen.findByRole("heading", { name: "Веха" })).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((call) => call.method === "POST")?.init?.body))).toEqual({
      name: "Веха",
      color: "#0C5CAB",
      icon: "flag",
    });
    expect(screen.getByLabelText("Иконка")).toHaveValue("flag");
    expect(screen.getByRole("button", { name: "Удалить" })).toBeInTheDocument();
  });

  test("type page reorders fields and saves the order", async () => {
    const calls = api({
      "PATCH /api/v1/ticket-types/type-story": (init) => ({
        status: 200,
        body: { ...story, ...JSON.parse(String(init?.body)) },
      }),
    });
    renderApp("/types/type-story");
    await userEvent.click(await screen.findByRole("button", { name: "Ниже: Размер" }));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "PATCH")?.init?.body)).fieldIds).toEqual([
      "f-days",
      "f-size",
    ]);
  });
});
