import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * YT-15, «что показать команде»: лид собирает чипами «стрим = ГД или колодец исполнителя = ГД» →
 * переключает в текст → сохраняет для всех; участник открывает общий фильтр. Ошибка в тексте подсвечена.
 * У Бена интерфейс на английском (язык из профиля), у Анны — на русском.
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
  const context = await browser.newContext({ baseURL: baseURL ?? "", locale: "ru-RU" });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await signIn(page, login);
  return page;
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("the lead builds «stream = GD or assignee.guild = GD» with chips → switches to text → saves it for everyone; a member opens it", async ({
  page,
  browser,
  baseURL,
}) => {
  // Подготовка (админ): у колодца ГД — системное имя GD и лид Бен; два тикета в «Производстве».
  await signIn(page, "admin", "123456");
  type Item = { id: string; name: string; catalog?: { username?: string } };
  const people = (await api<{ items: Item[] }>(page, "GET", "/api/v1/people")).items;
  const ben = people.find((person) => person.catalog?.username === "ben") as Item;
  const guilds = (await api<{ items: Item[] }>(page, "GET", "/api/v1/guilds")).items;
  const existing = guilds.find((item) => item.name === "ГД");
  const gd = existing
    ? await api<Item>(page, "PATCH", `/api/v1/guilds/${existing.id}`, {
        key: "GD",
        leadId: ben.id,
        memberIds: [ben.id],
      })
    : await api<Item>(page, "POST", "/api/v1/guilds", { name: "ГД", key: "GD", leadId: ben.id, memberIds: [ben.id] });
  const types = (await api<{ items: { id: string; key: string }[] }>(page, "GET", "/api/v1/ticket-types")).items;
  const story = (types.find((type) => type.key === "story") as { id: string }).id;
  const streamed = await api<{ key: string; version: number }>(page, "POST", "/api/v1/tickets", {
    spaceId: "space-production",
    typeId: story,
    title: "Поиск: сюжет стрима ГД",
  });
  await api(page, "PATCH", `/api/v1/tickets/${streamed.key}`, {
    version: streamed.version,
    values: { stream: [gd.id] },
  });

  // Лид ГД собирает запрос чипами.
  const lead = await asUser(browser, "ben", baseURL);
  await lead.goto("/search?space=production");
  await expect(lead.getByRole("button", { name: /Builder/, pressed: true })).toBeVisible();
  for (const field of ["stream", "assignee.guild"]) {
    await lead.getByRole("button", { name: "condition", exact: true }).click();
    const form = lead.getByRole("group", { name: "Condition" });
    await form.getByLabel("Field").selectOption(field);
    await form.getByLabel("Value", { exact: true }).fill("GD");
    await form.getByRole("button", { name: "Save" }).click();
  }
  await lead.getByRole("button", { name: /^and —/ }).click();
  await expect(lead.getByRole("button", { name: /^or —/ })).toBeVisible();

  // Переключает в текст: тот же запрос, без потерь; и обратно.
  await lead.getByRole("button", { name: /Text/ }).click();
  await expect(lead.getByLabel("TQL query")).toHaveValue("stream = GD or assignee.guild = GD");
  await lead.getByRole("button", { name: /Builder/ }).click();
  await expect(lead.getByRole("button", { name: "assignee.guild = GD", exact: true })).toBeVisible();
  await lead.getByRole("button", { name: /Text/ }).click();
  await expect(lead.getByLabel("TQL query")).toHaveValue("stream = GD or assignee.guild = GD");
  await lead.getByRole("button", { name: "Search", exact: true }).click();
  await expect(lead.getByRole("link", { name: new RegExp(`${streamed.key} Поиск: сюжет стрима ГД`) })).toBeVisible();
  await expect(lead.getByRole("status").filter({ hasText: /Found: \d+/ })).toBeVisible();

  // Сохраняет для всех в «Производстве».
  await lead.getByLabel("Save as").fill("Доска лида ГД");
  await lead.getByRole("checkbox", { name: /For everyone in/ }).check();
  await lead.getByRole("button", { name: "Save filter" }).click();
  await expect(lead.getByText("Filter “Доска лида ГД” saved for everyone.")).toBeVisible();

  // Участник открывает общий фильтр.
  const member = await asUser(browser, "anna", baseURL);
  await member.goto("/search?space=production");
  const shared = member.getByRole("complementary", { name: "Сохранённые фильтры" });
  await shared.getByRole("button", { name: "Доска лида ГД" }).click();
  await expect(member.getByRole("link", { name: new RegExp(`${streamed.key} Поиск: сюжет стрима ГД`) })).toBeVisible();
  await member.getByRole("button", { name: /Текст/ }).click();
  await expect(member.getByLabel("Запрос TQL")).toHaveValue("stream = GD or assignee.guild = GD");

  // Ошибка в тексте подсвечена с понятной подсказкой.
  await member.getByLabel("Запрос TQL").fill("staus = Done");
  await expect(member.getByRole("alert")).toContainText("Нет поля «staus». Может быть, status?");
  await expect(member.getByRole("alert").locator("mark")).toHaveText("staus");

  // Ctrl+K: ключ — сразу к тикету.
  await member.keyboard.press("Control+k");
  const palette = member.getByRole("dialog", { name: "Командная строка" });
  await palette.getByLabel("Ключ, слова или запрос TQL").fill(streamed.key);
  await expect(palette.getByRole("option").first()).toContainText(streamed.key);
  await palette.getByLabel("Ключ, слова или запрос TQL").press("Enter");
  await expect(member).toHaveURL(new RegExp(`/tickets/${streamed.key}$`));
});
