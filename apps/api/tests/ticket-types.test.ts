import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Converter, EstimateScale, Space, TicketField, TicketTemplate, TicketType } from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-04: конструктор типов, полей, шаблонов и оценок (R-2.5, R-2.7, R-2.26; docs/adr/0010). */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

async function send<T>(user: Client, method: string, url: string, body?: unknown) {
  const response = await user.request(method, url, body, await csrf(user));
  return {
    status: response.statusCode,
    body: (response.body ? response.json() : undefined) as T & { code?: string; errors?: { field: string }[] },
  };
}
const get = async <T>(user: Client, url: string) => (await user.request("GET", url)).json() as T;
const items = async <T>(user: Client, url: string) => (await get<{ items: T[] }>(user, url)).items;

async function catalog() {
  const types = await items<TicketType>(admin, "/api/v1/ticket-types");
  const fields = await items<TicketField>(admin, "/api/v1/fields");
  const scales = await items<EstimateScale>(admin, "/api/v1/estimate-scales");
  const type = (key: string) => types.find((item) => item.key === key) as TicketType;
  const field = (key: string) => fields.find((item) => item.key === key) as TicketField;
  const scale = (key: string) => scales.find((item) => item.key === key) as EstimateScale;
  return { types, fields, scales, type, field, scale };
}

describe("start data after installation", () => {
  test("six start types, three start templates, T-shirt and days scales, default converter", async () => {
    const { types, type, scale } = await catalog();
    expect(types.map((item) => item.name)).toEqual(["Цель", "Эпик", "Стори", "Задача", "Баг", "Реквест"]);
    expect(types.every((item) => item.system && /^#[0-9A-F]{6}$/.test(item.color))).toBe(true);
    expect(type("story").templates.map((item) => item.name)).toEqual(["Стори"]);
    expect(type("task").templates.map((item) => item.name)).toEqual(["Обычная задача"]);
    expect(type("bug").templates.map((item) => item.name)).toEqual(["Баг"]);
    expect(type("epic").rollups).toMatchObject({ status: true, progress: "children", estimates: true });

    // Состав «Стори» и «Бага» — R-2.7.
    const story = await get<TicketTemplate>(admin, `/api/v1/ticket-templates/${type("story").templates[0]?.id}`);
    for (const section of [
      "Задача",
      "Документы",
      "Цели",
      "Требования",
      "Список контента",
      "Шаги производства",
      "Критерии приёмки",
    ]) {
      expect(story.description).toContain(`## ${section}`);
    }
    const bug = await get<TicketTemplate>(admin, `/api/v1/ticket-templates/${type("bug").templates[0]?.id}`);
    for (const section of [
      "Краткое описание",
      "Шаги воспроизведения",
      "Ожидаемый результат",
      "Фактический результат",
      "Материалы",
      "Связь с фичей",
    ]) {
      expect(bug.description).toContain(`## ${section}`);
    }
    expect(bug.values).toEqual({ severity: "field-severity-normal" });

    expect(scale("tshirt").values.map((value) => value.label)).toEqual(["XS", "S", "M", "L", "XL"]);
    expect(scale("days")).toMatchObject({ kind: "numeric", unit: "дн." });
    const converter = await get<Converter>(admin, "/api/v1/estimate-converter");
    const m = scale("tshirt").values.find((value) => value.label === "M");
    expect(converter.entries.find((entry) => entry.valueId === m?.id)).toMatchObject({ minDays: 3, maxDays: 5 });
  });
});

describe("admin builds structure without a developer", () => {
  test("type «Веха» with color, icon and its own field", async () => {
    const field = await send<TicketField>(admin, "POST", "/api/v1/fields", {
      name: "Платформа релиза",
      kind: "list",
      options: ["Steam", "PlayStation", " steam ", "Xbox"],
      multiple: true,
    });
    expect(field.status).toBe(201);
    expect(field.body).toMatchObject({ key: "platforma_reliza", kind: "list", multiple: true });
    expect(field.body.options.map((option) => option.label)).toEqual(["Steam", "PlayStation", "Xbox"]);

    const { field: start, type } = await catalog();
    const milestone = await send<TicketType>(admin, "POST", "/api/v1/ticket-types", {
      name: "Веха",
      key: "milestone",
      color: "#0ea5e9",
      icon: "flag",
      fieldIds: [field.body.id, start("due_date").id, start("size").id],
      rollups: { status: true, progress: "children", dates: true },
      allowedParentTypeIds: [type("goal").id],
    });
    expect(milestone.status).toBe(201);
    expect(milestone.body).toMatchObject({
      key: "milestone",
      color: "#0EA5E9",
      icon: "flag",
      fieldIds: [field.body.id, start("due_date").id, start("size").id],
      rollups: { status: true, progress: "children", progressByEstimate: false, dates: true, estimates: false },
      allowedParentTypeIds: [type("goal").id],
      templates: [],
      system: false,
    });

    const renamed = await send<TicketType>(admin, "PATCH", `/api/v1/ticket-types/${milestone.body.id}`, {
      name: "Веха релиза",
      fieldIds: [start("due_date").id, field.body.id],
    });
    expect(renamed.body).toMatchObject({ name: "Веха релиза", fieldIds: [start("due_date").id, field.body.id] });

    // Поле, которое использует тип, удалить нельзя; системный тип — тоже.
    expect((await send(admin, "DELETE", `/api/v1/fields/${field.body.id}`)).body.code).toBe("conflict");
    expect((await send(admin, "DELETE", `/api/v1/ticket-types/${type("story").id}`)).body.code).toBe("conflict");
    expect((await send(admin, "DELETE", `/api/v1/ticket-types/${milestone.body.id}`)).status).toBe(204);
    expect((await send(admin, "DELETE", `/api/v1/fields/${field.body.id}`)).status).toBe(204);
  });

  test("every field kind; system names are Latin and not reserved", async () => {
    const { scale } = await catalog();
    const dimensions = await items<{ id: string; key: string }>(admin, "/api/v1/dimensions");
    const kinds = [
      { name: "Заметка", kind: "text" },
      { name: "Бюджет", kind: "number" },
      { name: "Дата анонса", kind: "date" },
      { name: "Ревьюеры", kind: "person", multiple: true },
      { name: "Сложность", kind: "estimate", scaleId: scale("tshirt").id },
      { name: "Команда-владелец", kind: "dimension", dimensionId: dimensions.find((item) => item.key === "team")?.id },
    ];
    for (const input of kinds) {
      const created = await send<TicketField>(admin, "POST", "/api/v1/fields", input);
      expect(created.status, input.name).toBe(201);
      expect(created.body.key).toMatch(/^[a-z][a-z0-9_]+$/);
    }
    const reject = async (body: unknown, field: string) => {
      const response = await send(admin, "POST", "/api/v1/fields", body);
      expect(response.body.code, JSON.stringify(body)).toBe("validation_failed");
      expect(response.body.errors?.[0]?.field).toBe(field);
    };
    await reject({ name: "Статус", key: "status", kind: "text" }, "key");
    await reject({ name: "Поле", key: "Поле", kind: "text" }, "key");
    await reject({ name: "Оценка", kind: "estimate" }, "scaleId");
    await reject({ name: "Измерение", kind: "dimension" }, "dimensionId");
    await reject({ name: "Список", kind: "list" }, "options");
    await reject({ name: "Текст", kind: "text", multiple: true }, "multiple");
    expect((await send(admin, "POST", "/api/v1/fields", { name: "Бюджет", kind: "number" })).body.code).toBe(
      "conflict",
    );
  });

  test("a story gets a second template; each keeps its own structure, checklist and values", async () => {
    const { type, field, scale } = await catalog();
    const m = scale("tshirt").values.find((value) => value.label === "M")?.id;
    const created = await send<TicketTemplate>(admin, "POST", `/api/v1/ticket-types/${type("story").id}/templates`, {
      name: "Стори арта",
      description: "## Референсы\n- \n\n## Что рисуем\n",
      checklist: ["Скетч согласован", "Финал в движке"],
      values: { size: m, estimate_days: 6, severity: undefined },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      checklist: ["Скетч согласован", "Финал в движке"],
      values: { size: m, estimate_days: 6 },
    });

    const templates = await items<TicketTemplate>(admin, `/api/v1/ticket-types/${type("story").id}/templates`);
    expect(templates.map((item) => item.name)).toEqual(["Стори", "Стори арта"]);
    expect(templates[0]?.description).toContain("## Критерии приёмки");
    expect(templates[1]?.description).toContain("## Референсы");

    const bad = async (values: Record<string, unknown>, field: string) => {
      const response = await send(admin, "PATCH", `/api/v1/ticket-templates/${created.body.id}`, { values });
      expect(response.body.code, JSON.stringify(values)).toBe("validation_failed");
      expect(response.body.errors?.[0]?.field).toBe(field);
    };
    await bad({ severity: "field-severity-normal" }, "values/severity"); // у стори нет «Серьёзности»
    await bad({ size: "XXL" }, "values/size");
    await bad({ estimate_days: "шесть" }, "values/estimate_days");
    await bad({ due_date: "2026-13-45" }, "values/due_date");
    await bad({ team: "nobody" }, "values/team");
    await bad({ team: ["a", "b"] }, "values/team");

    const teams = await items<{ id: string; name: string }>(admin, "/api/v1/feature-teams");
    const ok = await send<TicketTemplate>(admin, "PATCH", `/api/v1/ticket-templates/${created.body.id}`, {
      values: { team: teams[0]?.id, due_date: "2026-12-01", size: m },
    });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body.values).sort()).toEqual(["due_date", "size", "team"]);

    // Убрали поле из типа — значение в шаблоне скрыто, но не стёрто; вернули — снова видно.
    const withoutSize = type("story").fieldIds.filter((id) => id !== field("size").id);
    await send(admin, "PATCH", `/api/v1/ticket-types/${type("story").id}`, { fieldIds: withoutSize });
    expect((await get<TicketTemplate>(admin, `/api/v1/ticket-templates/${created.body.id}`)).values).not.toHaveProperty(
      "size",
    );
    await send(admin, "PATCH", `/api/v1/ticket-types/${type("story").id}`, { fieldIds: type("story").fieldIds });
    expect((await get<TicketTemplate>(admin, `/api/v1/ticket-templates/${created.body.id}`)).values.size).toBe(m);

    expect((await send(admin, "DELETE", `/api/v1/ticket-templates/${templates[0]?.id}`)).body.code).toBe("conflict");
    expect((await send(admin, "DELETE", `/api/v1/ticket-templates/${created.body.id}`)).status).toBe(204);
  });
});

describe("estimates and converter (R-2.26)", () => {
  test("own scale and a space converter; the default applies until a space sets its own", async () => {
    const points = await send<EstimateScale>(admin, "POST", "/api/v1/estimate-scales", {
      name: "Очки",
      key: "points",
      kind: "numeric",
      unit: "очк.",
    });
    expect(points.status).toBe(201);
    const fib = await send<EstimateScale>(admin, "POST", "/api/v1/estimate-scales", {
      name: "Фибоначчи",
      kind: "ordinal",
      values: ["1", "2", "3", "5", "8"],
    });
    expect(fib.body.values.map((value) => value.label)).toEqual(["1", "2", "3", "5", "8"]);

    const spaces = await items<Space>(admin, "/api/v1/spaces");
    const core = spaces.find((space) => space.slug === "core") as Space;
    let converter = await get<Converter>(admin, `/api/v1/spaces/${core.id}/estimate-converter`);
    expect(converter.inherited).toBe(true);

    const { scale } = await catalog();
    const tshirt = scale("tshirt");
    const entries = [
      ...tshirt.values.map((value, index) => ({
        scaleId: tshirt.id,
        valueId: value.id,
        minDays: index * 2 + 1,
        maxDays: index * 2 + 2,
      })),
      { scaleId: points.body.id, valueId: null, minDays: 0.5, maxDays: 1 },
    ];
    converter = (await send<Converter>(admin, "PUT", `/api/v1/spaces/${core.id}/estimate-converter`, { entries })).body;
    expect(converter).toMatchObject({ spaceId: core.id, inherited: false });
    expect(converter.entries).toHaveLength(6);
    // Конвертер по умолчанию не тронут.
    const m = tshirt.values[2]?.id;
    expect(
      (await get<Converter>(admin, "/api/v1/estimate-converter")).entries.find((entry) => entry.valueId === m),
    ).toMatchObject({
      minDays: 3,
      maxDays: 5,
    });

    const invalid = async (row: unknown, message: RegExp) => {
      const response = await send(admin, "PUT", `/api/v1/spaces/${core.id}/estimate-converter`, { entries: [row] });
      expect(response.body.code).toBe("validation_failed");
      expect(JSON.stringify(response.body.errors)).toMatch(message);
    };
    await invalid({ scaleId: scale("days").id, valueId: null, minDays: 1, maxDays: 1 }, /days scale/);
    await invalid({ scaleId: tshirt.id, valueId: "nope", minDays: 1, maxDays: 2 }, /unknown value/);
    await invalid({ scaleId: tshirt.id, valueId: m, minDays: 5, maxDays: 2 }, /maxDays/);
    await invalid({ scaleId: points.body.id, valueId: null, minDays: 0, maxDays: 1 }, /above zero/);

    expect(
      (await send<Converter>(admin, "DELETE", `/api/v1/spaces/${core.id}/estimate-converter`)).body.inherited,
    ).toBe(true);
    // Шкалу, на которую ссылается поле, удалить нельзя.
    await send(admin, "POST", "/api/v1/fields", { name: "Очки", kind: "estimate", scaleId: points.body.id });
    expect((await send(admin, "DELETE", `/api/v1/estimate-scales/${points.body.id}`)).body.code).toBe("conflict");
    expect((await send(admin, "DELETE", `/api/v1/estimate-scales/${scale("tshirt").id}`)).body.code).toBe("conflict");
  });

  test("a story with M and 6 days: the parent sums in the chosen scale", async () => {
    const { scale } = await catalog();
    const tshirt = scale("tshirt");
    const days = scale("days");
    const id = (label: string) => tshirt.values.find((value) => value.label === label)?.id as string;
    const story = [
      { scaleId: tshirt.id, value: id("M") },
      { scaleId: days.id, value: 6 },
    ];
    const smallTask = [{ scaleId: tshirt.id, value: id("S") }];
    const noEstimate: unknown[] = [];

    const inDays = await send<{ result: { min: number; max: number; exact: boolean }; counted: number }>(
      admin,
      "POST",
      "/api/v1/estimates/rollup",
      { targetScaleId: days.id, children: [story, smallTask, noEstimate] },
    );
    // Стори даёт свои 6 дней как есть, S приводится конвертером (1–2 дня).
    expect(inDays.body).toMatchObject({ result: { min: 7, max: 8, exact: false }, counted: 2 });

    const inSizes = await send<{ result: { min: number; max: number; valueId: string } }>(
      admin,
      "POST",
      "/api/v1/estimates/rollup",
      {
        targetScaleId: tshirt.id,
        children: [story, smallTask, story],
      },
    );
    // В майках: M (3–5) + S (1–2) + M (3–5) = 7–12 дней → ближе всего L (6–10).
    expect(inSizes.body.result).toMatchObject({ min: 7, max: 12, valueId: id("L") });

    const onlyDays = await send<{ result: { valueId: string } }>(admin, "POST", "/api/v1/estimates/rollup", {
      targetScaleId: tshirt.id,
      children: [[{ scaleId: days.id, value: 6 }]],
    });
    expect(onlyDays.body.result.valueId).toBe(id("L"));
  });
});

describe("subordination rules", () => {
  test("off by default; switched on per space", async () => {
    const { type } = await catalog();
    await send(admin, "PATCH", `/api/v1/ticket-types/${type("story").id}`, { allowedParentTypeIds: [type("epic").id] });
    const spaces = await items<Space>(admin, "/api/v1/spaces");
    expect(spaces.every((space) => space.enforceSubordination === false)).toBe(true);
    const core = spaces.find((space) => space.slug === "core") as Space;
    const production = spaces.find((space) => space.slug === "production") as Space;
    const check = async (space: Space, parent: string) =>
      get<{ allowed: boolean; enforced: boolean }>(
        admin,
        `/api/v1/ticket-types/subordination?spaceId=${space.id}&parentTypeId=${type(parent).id}&childTypeId=${type("story").id}`,
      );
    expect(await check(core, "goal")).toEqual({ allowed: true, enforced: false });

    const switched = await send<Space>(admin, "PATCH", `/api/v1/spaces/${core.id}`, { enforceSubordination: true });
    expect(switched.body).toMatchObject({ name: "Core", enforceSubordination: true });
    expect(await check(core, "goal")).toEqual({ allowed: false, enforced: true });
    expect(await check(core, "epic")).toEqual({ allowed: true, enforced: true });
    expect(await check(production, "goal")).toEqual({ allowed: true, enforced: false });
  });
});

describe("rights and isolation", () => {
  test("members read the structure but cannot change it; test types are hidden from regular users", async () => {
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await items<TicketType>(anna, "/api/v1/ticket-types")).length).toBe(6);
    expect(
      (await send(anna, "POST", "/api/v1/ticket-types", { name: "X", color: "#000000", icon: "flag" })).body.code,
    ).toBe("forbidden");
    expect((await send(anna, "POST", "/api/v1/fields", { name: "X", kind: "text" })).body.code).toBe("forbidden");
    expect((await send(anna, "PUT", "/api/v1/estimate-converter", { entries: [] })).body.code).toBe("forbidden");

    await send(admin, "POST", "/api/v1/ticket-types", { name: "Тестовый тип", color: "#123456", icon: "cube" });
    const vera = (await signIn(app, { login: "vera" })).user;
    expect((await items<TicketType>(vera, "/api/v1/ticket-types")).map((item) => item.name)).not.toContain(
      "Тестовый тип",
    );
    expect((await items<TicketType>(anna, "/api/v1/ticket-types")).map((item) => item.name)).toContain("Тестовый тип");
  });

  test("bad color, icon and duplicate names are rejected in the unified format", async () => {
    expect(
      (await send(admin, "POST", "/api/v1/ticket-types", { name: "A", color: "red", icon: "flag" })).body.code,
    ).toBe("validation_failed");
    expect(
      (await send(admin, "POST", "/api/v1/ticket-types", { name: "A", color: "#000000", icon: "nope" })).body.code,
    ).toBe("validation_failed");
    expect(
      (await send(admin, "POST", "/api/v1/ticket-types", { name: "Стори", color: "#000000", icon: "flag" })).body.code,
    ).toBe("conflict");
    expect(
      (
        await send(admin, "POST", "/api/v1/ticket-types", {
          name: "B",
          color: "#000000",
          icon: "flag",
          fieldIds: ["nope"],
        })
      ).body.errors?.[0]?.field,
    ).toBe("fieldIds");
  });
});
