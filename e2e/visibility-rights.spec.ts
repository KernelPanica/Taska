import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * YT-08, «что показать команде»: продюсер скрывает содержимое эпика → смотрит как участник → видит только
 * заголовок. Лид ГД правит тикет своего стрима в чужой команде.
 * Файл назван так, чтобы идти после structure.spec.ts: тот заводит «Жабы» и «ГД» через интерфейс.
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
  // Язык интерфейса — из профиля человека: у Бена английский.
  await expect(page.getByRole("heading", { name: /^(Пространства|Spaces)$/ })).toBeVisible();
}

/** Запрос к API от имени вошедшего в этой вкладке (интерфейс работает только через API, R-3.2). */
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

test("the producer hides an epic's content, views as a member from their profile and sees only the title; the GD lead edits a ticket of his stream in another team", async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page, "admin", "123456");
  type Item = { id: string; name: string; catalog?: { username?: string } };
  const people = (await api<{ items: Item[] }>(page, "GET", "/api/v1/people")).items;
  const ben = people.find((person) => person.catalog?.username === "ben") as Item;
  const member = people.find((person) => person.catalog?.username === "anna") as Item;
  const findOrCreate = async (path: string, name: string, body: Record<string, unknown>) => {
    const found = (await api<{ items: Item[] }>(page, "GET", path)).items.find((item) => item.name === name);
    if (found) return Object.keys(body).length ? api<Item>(page, "PATCH", `${path}/${found.id}`, body) : found;
    return api<Item>(page, "POST", path, { name, ...body });
  };
  const pigs = await findOrCreate("/api/v1/feature-teams", "Хрюшки", {});
  const gd = await findOrCreate("/api/v1/guilds", "ГД", { leadId: ben.id, memberIds: [ben.id] });
  const types = (await api<{ items: { id: string; key: string }[] }>(page, "GET", "/api/v1/ticket-types")).items;
  const typeId = (key: string) => (types.find((type) => type.key === key) as { id: string }).id;
  const epic = await api<{ key: string }>(page, "POST", "/api/v1/tickets", {
    spaceId: "space-production",
    typeId: typeId("epic"),
    title: "Секретный эпик",
  });
  await api(page, "POST", "/api/v1/tickets", {
    spaceId: "space-production",
    typeId: typeId("task"),
    title: "Сцена с боссом",
    parentKey: epic.key,
  });
  const scenario = await api<{ key: string; version: number }>(page, "POST", "/api/v1/tickets", {
    spaceId: "space-production",
    typeId: typeId("story"),
    title: "Сценарий боя",
  });
  await api(page, "PATCH", `/api/v1/tickets/${scenario.key}`, {
    version: scenario.version,
    values: { team: pigs.id, stream: [gd.id] },
  });

  // Продюсер скрывает содержимое эпика: «Только заголовок».
  await page.goto(`/tickets/${epic.key}`);
  await page.getByLabel("Кому видно").selectOption({ label: "Только заголовок" });
  await page.getByRole("button", { name: "Применить видимость" }).click();
  await expect(page.getByText("Только заголовок", { exact: true }).first()).toBeVisible();

  // Смотрит глазами участника из его профиля.
  await page.goto(`/people/${member.id}`);
  await page.getByRole("button", { name: "Смотреть глазами", exact: true }).click();
  const lensBanner = page.getByText(`Смотрите глазами: ${member.name}`, { exact: true });
  await expect(lensBanner).toBeVisible();
  await page.goto(`/tickets/${epic.key}`);
  await page.reload();
  await expect(lensBanner).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Секретный эпик" })).toBeVisible();
  await expect(page.getByText("Видно только название")).toBeVisible();
  await expect(page.getByText("Сцена с боссом")).toHaveCount(0);
  // В списке пространства эпик с пометкой, ребёнка нет вовсе.
  await page.goto("/spaces/production");
  await expect(page.getByRole("link", { name: "Секретный эпик" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Сцена с боссом" })).toHaveCount(0);
  // Дирекция при просмотре глазами участника не видна.
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Дирекция/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Выключить" }).first().click();
  await expect(lensBanner).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Дирекция/ })).toBeVisible();

  // Лид ГД правит описание тикета своего стрима в команде Хрюшки, но не исполнителя.
  const lead = await asUser(browser, "ben", baseURL);
  await lead.goto(`/tickets/${scenario.key}`);
  await expect(lead.getByRole("heading", { level: 1, name: "Сценарий боя" })).toBeVisible();
  // У Бена интерфейс на английском (язык — из профиля).
  await lead.getByRole("button", { name: "Edit" }).last().click();
  await lead.getByRole("textbox", { name: "Description" }).fill("Босс меняет фазу на 50% здоровья");
  await lead.getByRole("button", { name: "Save" }).first().click();
  // Сохранено: редактор закрылся, в описании — новый текст.
  await expect(lead.getByRole("textbox", { name: "Description" })).toHaveCount(0);
  await expect(lead.getByText("Босс меняет фазу на 50% здоровья")).toBeVisible();
  await expect(
    lead
      .getByRole("group", { name: /Assignees/ })
      .getByRole("checkbox")
      .first(),
  ).toBeDisabled();
  await expect(lead.getByText(/team changes the status/)).toBeVisible();
});
