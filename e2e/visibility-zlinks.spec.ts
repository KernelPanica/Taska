import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * YT-12, «что показать команде»: стори блокирует другую → баг «вызван» стори → ссылка на ГДД в YourWiki
 * с живым названием → пользователь без доступа запрашивает его.
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
  await expect(page.getByRole("heading", { name: /^(Пространства|Spaces)$/ })).toBeVisible();
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
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      return response.json();
    },
    { method, path, body },
  );
}

async function asUser(browser: Browser, login: string, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL: baseURL ?? "", locale: "ru-RU" });
  const page = await context.newPage();
  await signIn(page, login);
  return page;
}

async function link(page: Page, kind: string, key: string) {
  const form = page.getByRole("form", { name: "Добавить связь или родителя" });
  await form.getByLabel("Связь").selectOption({ label: kind });
  await form.getByLabel("Ключ тикета").fill(key);
  await form.getByRole("button", { name: "Связать" }).click();
}

test("a story blocks another → a bug is caused by the story → a YourWiki GDD with a live title → a user without access asks for it", async ({
  page,
  browser,
  baseURL,
}) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await signIn(page, "admin", "123456");
  const types = await api<{ items: { id: string; key: string }[] }>(page, "GET", "/api/v1/ticket-types");
  const typeId = (key: string) => (types.items.find((type) => type.key === key) as { id: string }).id;
  const make = (title: string, key: string) =>
    api<{ key: string }>(page, "POST", "/api/v1/tickets", { spaceId: "space-production", typeId: typeId(key), title });
  const story = await make("Переключение персонажа в бою", "story");
  const combo = await make("Комбо при переключении героя", "story");
  const bug = await make("Камера дёргается при переключении", "bug");

  // Стори блокирует другую — видно с обеих сторон.
  await page.goto(`/tickets/${story.key}`);
  await link(page, "Блокирует", combo.key);
  await expect(page.getByRole("region", { name: "Блокирует" }).getByRole("link", { name: combo.key })).toBeVisible();
  await page.goto(`/tickets/${combo.key}`);
  await expect(page.getByRole("region", { name: "Заблокирован" }).getByRole("link", { name: story.key })).toBeVisible();
  // Тип меняется одним действием, тикеты остаются.
  await page.getByRole("region", { name: "Заблокирован" }).getByLabel("Тип связи").selectOption({ label: "Связан с" });
  await expect(page.getByRole("region", { name: "Связан с" }).getByRole("link", { name: story.key })).toBeVisible();

  // Баг «вызван» стори и не становится ребёнком.
  await page.goto(`/tickets/${bug.key}`);
  await link(page, "Вызван", story.key);
  await expect(page.getByRole("region", { name: "Вызван" }).getByRole("link", { name: story.key })).toBeVisible();
  await page.goto(`/tickets/${story.key}`);
  await expect(page.getByRole("region", { name: "Вызывает" }).getByRole("link", { name: bug.key })).toBeVisible();
  await expect(page.getByText("Детей нет")).toBeVisible();

  // Ссылка на ГДД в YourWiki — живое название; переименовали в YourWiki — название в тикете тоже.
  const wiki = `${baseURL}/dev/yourwiki/documents`;
  await page.getByLabel("Адрес").fill(`${wiki}/gdd-combat`);
  await page.getByRole("button", { name: "Добавить ссылку" }).click();
  await expect(page.getByRole("link", { name: "ГДД: боевая система" })).toBeVisible();
  await expect(page.getByText("доступ есть")).toBeVisible();
  await page.getByLabel("Адрес").fill(`${wiki}/tech-camera`);
  await page.getByRole("button", { name: "Добавить ссылку" }).click();
  await expect(page.getByRole("link", { name: "ТехГДД: камера" })).toBeVisible();

  await page.goto("/dev/yourwiki");
  await page.getByLabel("Название gdd-combat").fill("ГДД: боевая система, ред. 2");
  await page.getByLabel("Название gdd-combat").press("Enter");
  await page.goto(`/tickets/${story.key}`);
  await expect(page.getByRole("link", { name: "ГДД: боевая система, ред. 2" })).toBeVisible();

  // У Анны нет доступа к ТехГДД: «нет доступа», названия не видно, «Запросить» — запрос уходит в YourWiki.
  const anna = await asUser(browser, "anna", baseURL);
  await anna.goto(`/tickets/${story.key}`);
  await expect(anna.getByRole("link", { name: "ГДД: боевая система, ред. 2" })).toBeVisible();
  await expect(anna.getByText("нет доступа")).toBeVisible();
  await expect(anna.getByText("ТехГДД: камера")).toHaveCount(0);
  await anna.getByRole("button", { name: "Запросить" }).click();
  await expect(anna.getByText("Запрос отправлен")).toBeVisible();
  await page.goto("/dev/yourwiki");
  await expect(page.getByRole("row", { name: /ТехГДД/ })).toContainText("ys-test-anna");
});
