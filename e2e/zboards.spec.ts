import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

/**
 * YT-16, «что показать команде»: рабочий поток из 16 задач Жаб — создание доски и карточек →
 * перенос по зонам с выбором статуса → отказ бага с причиной → детализация шапки → завершение.
 * Анна держит ту же доску открытой: перенос админа появляется у неё без перезагрузки, её детализация — своя.
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

const cardOf = (page: Page, title: string) => page.getByRole("article", { name: new RegExp(` ${title}$`) }).first();
const cellOf = (card: Locator, column: string) =>
  card.locator("xpath=ancestor::div[contains(@class,'board-row')]").getByRole("group", { name: column, exact: true });
const headers = (page: Page) => page.getByRole("columnheader");

// Высокое окно: и карточка, и колонка видны без прокрутки — иначе прокрутка между нажатием и движением
// мыши подменяет перетаскиваемую карточку (особенность HTML5 drag-and-drop в автотесте, не доски).
test.use({ viewport: { width: 2200, height: 2400 } });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("a working flow of 16 Frogs tasks: create → move through zones → header detail → finish; another person sees it live", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "admin", "123456");

  // Подготовка: Жабы (Анна — участница), колодец ГД; эпики-родители для дорожек и 14 задач в работе.
  type Item = { id: string; key?: string | null; name: string; catalog?: { username?: string } };
  const people = (await api<{ items: Item[] }>(page, "GET", "/api/v1/people")).items;
  const anna = people.find((person) => person.catalog?.username === "anna") as Item;
  const teams = (await api<{ items: Item[] }>(page, "GET", "/api/v1/feature-teams")).items;
  const found = teams.find((item) => item.key === "Frogs" || item.name === "Жабы");
  const frogs = found
    ? await api<Item>(page, "PATCH", `/api/v1/feature-teams/${found.id}`, { key: "Frogs", memberIds: [anna.id] })
    : await api<Item>(page, "POST", "/api/v1/feature-teams", { name: "Жабы", key: "Frogs", memberIds: [anna.id] });
  type Type = { id: string; key: string };
  const types = (await api<{ items: Type[] }>(page, "GET", "/api/v1/ticket-types")).items;
  const type = (key: string) => (types.find((item) => item.key === key) as Type).id;
  type Ticket = { key: string; version: number };
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const make = async (title: string, kind: string, parentKey?: string) => {
    const created = await api<Ticket>(page, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: type(kind),
      title,
      ...(parentKey ? { parentKey } : {}),
    });
    return api<Ticket>(page, "PATCH", `/api/v1/tickets/${created.key}`, {
      version: created.version,
      values: { team: frogs.id, ...(kind === "story" || kind === "task" ? { due_date: due } : {}) },
      people: { assigneeIds: [anna.id], testerId: anna.id },
    });
  };
  const combat = await make("Боевая система e2e", "epic");
  const hud = await make("Интерфейс боя e2e", "epic");
  const titles = [
    "Комбо при переключении",
    "Баланс урона партии",
    "Агро врагов при смене героя",
    "Базовая атака ближнего боя",
    "Скрипт смены камеры",
    "Подсказки управления партией",
    "Индикатор активного героя",
    "HUD: портреты партии",
    "Иконки состояний героев",
    "Финализация HUD",
    "Звук смены героя",
    "Анимация уклонения",
  ];
  for (const [index, title] of titles.entries())
    await make(title, index % 4 === 3 ? "task" : "story", index < 6 ? combat.key : hud.key);
  await make("Камера дёргается при переключении", "bug", combat.key);

  // 1. Создание доски — фильтр TQL и дорожки по родителю; это фильтр, а не копия тикетов.
  await page.goto("/boards");
  await page.getByLabel("Название доски").fill("Жабы — поток");
  await page.getByLabel("Фильтр TQL").fill("team = Frogs or involvedTeams = Frogs");
  await page.getByLabel("Владелец").selectOption({ label: "Производство" });
  await page.getByLabel("Дорожки:").selectOption("parent");
  await page.getByRole("button", { name: "Создать доску" }).click();
  await expect(page.getByRole("heading", { name: "Жабы — поток", level: 1 })).toBeVisible();
  const boardUrl = page.url();

  // 2. Создание карточки прямо с доски: команда берётся из фильтра, карточка сразу на доске (всего 16 задач).
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await page.getByLabel("Тип", { exact: true }).selectOption({ label: "Стори" });
  await page.getByLabel("Название", { exact: true }).fill("Переключение персонажа в бою");
  await page.getByRole("button", { name: "Создать", exact: true }).last().click();
  await expect(page.getByRole("status").filter({ hasText: "создан и уже на доске" })).toBeVisible();
  await expect(cardOf(page, "Переключение персонажа в бою")).toBeVisible();

  // Анна открывает ту же доску у себя.
  const annaPage = await asUser(browser, "anna", baseURL);
  await annaPage.goto(boardUrl);
  await expect(cardOf(annaPage, "Скрипт смены камеры")).toBeVisible();

  // 3. Перенос стори в «Производство»: выбор Creation или Implementation на месте броска.
  const camera = cardOf(page, "Скрипт смены камеры");
  await camera.dragTo(cellOf(camera, "Производство"));
  const chooser = page.getByRole("dialog", { name: "Какой статус в «Производство»?" });
  await expect(chooser.getByRole("button", { name: "Creation", exact: true })).toBeVisible();
  await expect(chooser.getByRole("button", { name: "Implementation", exact: true })).toBeVisible();
  await chooser.getByRole("button", { name: "Creation", exact: true }).click();
  await expect(cellOf(cardOf(page, "Скрипт смены камеры"), "Производство")).toContainText("Скрипт смены камеры");
  // …и у Анны без перезагрузки.
  await expect(cellOf(cardOf(annaPage, "Скрипт смены камеры"), "Производство")).toContainText("Скрипт смены камеры");

  // 4. Баг нельзя бросить в «Проработку»: причина объяснена, карточка на месте.
  const bug = cardOf(page, "Камера дёргается при переключении");
  await bug.dragTo(cellOf(bug, "Проработка"));
  await expect(page.getByRole("alert")).toContainText("«Баг» нельзя перенести в «Проработка»");
  await expect(cellOf(cardOf(page, "Камера дёргается при переключении"), "Бэклог")).toContainText("Камера дёргается");

  // 5. Детализация шапки: 3 — статусы; свернуть «Delivery» и развернуть обратно; 1 — только Discovery / Delivery / Done.
  await page.getByRole("button", { name: "3", exact: true }).click();
  await expect(headers(page).filter({ hasText: "Creation Done" })).toBeVisible();
  await page.getByRole("button", { name: "Свернуть зону «Delivery»" }).click();
  await expect(headers(page).filter({ hasText: "Производство" })).toHaveCount(0);
  await page.getByRole("button", { name: "Развернуть зону «Delivery»" }).click();
  await expect(headers(page).filter({ hasText: "Производство" }).first()).toBeVisible();
  await page.getByRole("button", { name: "1", exact: true }).click();
  await expect(headers(page)).toHaveCount(3);
  // У Анны доска не поменялась: её детализация — стартовая 2.
  await annaPage.reload();
  await expect(headers(annaPage).filter({ hasText: "Производство" })).toBeVisible();
  await page.getByRole("button", { name: "2", exact: true }).click();

  // 6. Дальше по потоку: Тест → Готово (завершение, единственный исход «выполнено» — без вопросов).
  const moving = cardOf(page, "Скрипт смены камеры");
  await moving.dragTo(cellOf(moving, "Тест"));
  await expect(cellOf(cardOf(page, "Скрипт смены камеры"), "Тест")).toContainText("Скрипт смены камеры");
  const testing = cardOf(page, "Скрипт смены камеры");
  await testing.dragTo(cellOf(testing, "Готово"));
  await expect(cellOf(cardOf(page, "Скрипт смены камеры"), "Готово")).toContainText("Выполнено");
  await expect(cellOf(cardOf(annaPage, "Скрипт смены камеры"), "Готово")).toContainText("Скрипт смены камеры");

  // 7. Новый пользователь — Анна — сразу видит «Мои задачи»: её тикеты в работе и в очереди, без завершённых.
  await annaPage.goto("/boards");
  await annaPage.getByRole("link", { name: "Мои задачи" }).first().click();
  await expect(annaPage.getByRole("heading", { name: "Мои задачи", level: 1 })).toBeVisible();
  await expect(cardOf(annaPage, "Баланс урона партии")).toBeVisible();
  await expect(cardOf(annaPage, "Скрипт смены камеры")).toHaveCount(0);
  await annaPage.context().close();
});
