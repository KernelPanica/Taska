import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * YT-17, «что показать команде»: доска лида ГД → дорожки по командам → выключение чипа → дорожки по стриму →
 * ссылка коллеге. Срочная дорожка priority = Urgent — сверху; чип запоминается после перезагрузки.
 */
async function signIn(page: Page, login: string, otp?: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Войти через YourSpace" }).click();
  await page.getByLabel("Логин / Login").fill(login);
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
  if (otp) {
    await page.getByLabel("Код / Code").fill(otp);
    await page.getByRole("button", { name: "Подтвердить / Verify" }).click();
  }
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const me = await (await fetch("/api/v1/me")).json();
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json", "x-yourtask-csrf": me.csrfToken },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
      return text ? JSON.parse(text) : null;
    },
    { method, path, body },
  );
}

async function asUser(browser: Browser, login: string, baseURL: string | undefined) {
  const context = await browser.newContext({
    baseURL: baseURL ?? "",
    locale: "ru-RU",
    viewport: { width: 2200, height: 2400 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await signIn(page, login);
  return page;
}

const lanes = (page: Page) => page.locator(".board-lane__title button");
const card = (page: Page, title: string) => page.getByRole("article", { name: new RegExp(` ${title}$`) }).first();

test.use({ viewport: { width: 2200, height: 1600 } });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("the GD lead: lanes by team → switch «Frogs» off → lanes by stream → a link for a colleague", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "admin", "123456");
  type Item = { id: string; key?: string | null; name: string; catalog?: { username?: string } };
  const people = (await api<{ items: Item[] }>(page, "GET", "/api/v1/people")).items;
  const ben = people.find((person) => person.catalog?.username === "ben") as Item;
  const ensure = async (path: string, name: string, key: string, extra: Record<string, unknown> = {}) => {
    const items = (await api<{ items: Item[] }>(page, "GET", path)).items;
    const found = items.find((item) => item.key === key || item.name === name);
    return found
      ? api<Item>(page, "PATCH", `${path}/${found.id}`, { key, ...extra })
      : api<Item>(page, "POST", path, { name, key, ...extra });
  };
  const frogs = await ensure("/api/v1/feature-teams", "Жабы", "Frogs");
  const pigs = await ensure("/api/v1/feature-teams", "Хрюшки", "Pigs");
  const lizards = await ensure("/api/v1/feature-teams", "Ящеры", "Lizards");
  const gd = await ensure("/api/v1/guilds", "ГД", "GD", { leadId: ben.id, memberIds: [ben.id] });
  const code = await ensure("/api/v1/guilds", "Код", "Code");
  type Type = { id: string; key: string };
  const types = (await api<{ items: Type[] }>(page, "GET", "/api/v1/ticket-types")).items;
  const type = (key: string) => (types.find((item) => item.key === key) as Type).id;
  const make = async (title: string, kind: string, values: Record<string, unknown>, priority = "normal") => {
    const created = await api<{ key: string; version: number }>(page, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: type(kind),
      title,
    });
    await api(page, "PATCH", `/api/v1/tickets/${created.key}`, { version: created.version, values, priority });
  };
  await make("Баланс урона партии e2e", "story", { team: frogs.id, stream: [gd.id, code.id] });
  await make("Агро врагов e2e", "story", { team: frogs.id, stream: [gd.id] });
  await make("Лут сундуков e2e", "task", { team: pigs.id, stream: [gd.id] });
  await make("Экономика крепости e2e", "story", { team: lizards.id, stream: [gd.id] });
  await make("Правила дружбы e2e", "request", { stream: [gd.id] });
  await make("Краш на старте e2e", "bug", { team: pigs.id, stream: [gd.id] }, "highest");
  const board = await api<{ id: string }>(page, "POST", "/api/v1/boards", {
    name: "Лид ГД e2e",
    query: 'stream = GD and text ~ "e2e"',
    spaceId: "space-production",
    lanes: "team",
    chips: ["team", "type"],
    tqlLanes: [{ id: "urgent", name: "Срочно", query: "priority = Urgent" }],
  });

  // Лид ГД открывает доску: дорожки по всем командам и «Без фичекоманды», срочная — сверху.
  const lead = await asUser(browser, "ben", baseURL);
  await lead.goto(`/boards/${board.id}`);
  await expect(card(lead, "Лут сундуков e2e")).toBeVisible();
  await expect(lanes(lead)).toHaveText(["Срочно", "Жабы", "Хрюшки", "Ящеры", /Без фичекоманды|No feature team/]);
  await expect(lead.getByRole("region", { name: "Срочно" })).toContainText("Краш на старте e2e");

  // Выключает чип «Жабы» — без перехода: дорожка исчезает, адрес тот же, состояние в адресе.
  const path = new URL(lead.url()).pathname;
  await lead
    .getByRole("group", { name: "Teams:" })
    .or(lead.getByRole("group", { name: "Команды:" }))
    .getByRole("button", { name: "Жабы" })
    .click();
  await expect(lanes(lead)).toHaveText(["Срочно", "Хрюшки", "Ящеры", /Без фичекоманды|No feature team/]);
  expect(new URL(lead.url()).pathname).toBe(path);

  // Чип помнится после перезагрузки — даже по «голому» адресу доски.
  await lead.goto(`/boards/${board.id}`);
  await expect(card(lead, "Лут сундуков e2e")).toBeVisible();
  await expect(card(lead, "Агро врагов e2e")).toHaveCount(0);

  // Дорожки по стриму: тикет с двумя стримами стоит в двух дорожках (а Жабы скрыты чипом — включим обратно).
  await lead.locator("button.board-chip", { hasText: "Жабы" }).click();
  await lead.getByLabel(/Дорожки:|Lanes:/).selectOption("stream");
  await expect(lanes(lead)).toContainText(["Срочно", "ГД", "Код"]);
  await expect(lead.getByRole("article", { name: / Баланс урона партии e2e$/ })).toHaveCount(2);
  await lead.locator("button.board-chip", { hasText: "Хрюшки" }).click();

  // Ссылка коллеге: фильтр, чипы и дорожки — в адресе.
  await lead.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await lead.getByRole("button", { name: /Ссылка на доску|Link to the board/ }).click();
  const link = await lead.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).searchParams.get("lanes")).toBe("stream");

  // Анна открывает ссылку: те же дорожки и чипы, в пределах её прав; её собственные настройки не тронуты.
  const anna = await asUser(browser, "anna", baseURL);
  await anna.goto(link);
  await expect(anna.getByLabel("Дорожки:")).toHaveValue("stream");
  await expect(anna.getByRole("group", { name: "Команды:" }).getByRole("button", { name: "Хрюшки" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(card(anna, "Лут сундуков e2e")).toHaveCount(0);
  await expect(card(anna, "Экономика крепости e2e")).toBeVisible();
  await anna.goto(`/boards/${board.id}`);
  await expect(anna.getByLabel("Дорожки:")).toHaveValue("team");
  await expect(anna.getByRole("group", { name: "Команды:" }).getByRole("button", { name: "Хрюшки" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await anna.context().close();
  await lead.context().close();
});
