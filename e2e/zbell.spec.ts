import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * YT-18, «что показать команде»: ПМ меняет статус → у наблюдателя загорается колокольчик (без перезагрузки,
 * со всплывающим уведомлением) → массовая правка 30 тикетов → одно сгруппированное уведомление.
 * Тестовый адаптер очереди получил то же, что колокольчик.
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

test.use({ viewport: { width: 1600, height: 1000 } });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("the PM changes a status → the watcher's bell lights up → a bulk edit → one grouped notification", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "admin", "123456");
  type Item = { id: string; key?: string | null; name: string; catalog?: { username?: string } };
  const people = (await api<{ items: Item[] }>(page, "GET", "/api/v1/people")).items;
  const who = (login: string) => people.find((person) => person.catalog?.username === login) as Item;
  const teams = (await api<{ items: Item[] }>(page, "GET", "/api/v1/feature-teams")).items;
  const found = teams.find((item) => item.key === "Frogs" || item.name === "Жабы");
  const frogs = found
    ? await api<Item>(page, "PATCH", `/api/v1/feature-teams/${found.id}`, {
        key: "Frogs",
        pmId: who("ben").id,
        memberIds: [who("anna").id],
      })
    : await api<Item>(page, "POST", "/api/v1/feature-teams", {
        name: "Жабы",
        key: "Frogs",
        pmId: who("ben").id,
        memberIds: [who("anna").id],
      });
  const types = (await api<{ items: { id: string; key: string }[] }>(page, "GET", "/api/v1/ticket-types")).items;
  const task = types.find((item) => item.key === "task")?.id;
  const make = async (title: string) => {
    const created = await api<{ key: string; version: number }>(page, "POST", "/api/v1/tickets", {
      spaceId: "space-production",
      typeId: task,
      title,
    });
    await api(page, "PATCH", `/api/v1/tickets/${created.key}`, {
      version: created.version,
      values: { team: frogs.id },
      people: { watcherIds: [who("anna").id] },
    });
    return created.key;
  };
  const camera = await make("Скрипт смены камеры уведомлений");
  for (let index = 1; index <= 30; index += 1) await make(`Пакетная задача ${index}`);

  // Анна (наблюдатель) открывает YourTask; прошлое в колокольчике прочитано.
  const anna = await asUser(browser, "anna", baseURL);
  await api(anna, "POST", "/api/v1/notifications/read", {});
  await anna.reload();
  await expect(anna.getByRole("button", { name: "Уведомления", exact: true })).toBeVisible();

  // 1. ПМ (Бен) меняет статус в карточке тикета.
  const ben = await asUser(browser, "ben", baseURL);
  await ben.goto(`/tickets/${camera}`);
  await ben.getByLabel(/Move to|Перевести в/).selectOption({ label: "To Do" });
  await ben.getByRole("button", { name: /^(Move|Перевести)$/ }).click();

  // 2. У Анны загорается колокольчик без перезагрузки, новое всплывает.
  await expect(anna.getByRole("button", { name: "Уведомления, новых: 1" })).toBeVisible();
  await expect(
    anna.getByRole("status").filter({ hasText: `${camera} «Скрипт смены камеры уведомлений» — Backlog → To Do` }),
  ).toBeVisible();

  // 3. Массовая правка 30 тикетов в поиске: выбрать все → статус Creation.
  await ben.goto(`/search?q=${encodeURIComponent('text ~ "Пакетная задача"')}`);
  const bar = ben.getByRole("form", { name: /Bulk edit|Массовая правка/ });
  await expect(ben.getByText(/Found: 30|Найдено: 30/)).toBeVisible();
  await bar.getByRole("checkbox").check();
  await bar.getByLabel(/^(Status|Статус)$/).selectOption("Creation");
  await bar.getByRole("button", { name: /\(30\)/ }).click();
  await expect(ben.getByText(/Tickets changed: 30|Изменено тикетов: 30/)).toBeVisible();

  // 4. У Анны — одно сгруппированное уведомление на все 30.
  await expect(anna.getByRole("button", { name: "Уведомления, новых: 2" })).toBeVisible();
  await anna.getByRole("button", { name: "Уведомления, новых: 2" }).click();
  const panel = anna.getByRole("region", { name: "Уведомления" });
  await expect(panel.getByRole("listitem").filter({ hasText: "новое" })).toHaveCount(2);
  const grouped = panel.getByRole("listitem").filter({ hasText: "статус 30 тикетов → Creation" });
  await expect(grouped).toHaveCount(1);
  await expect(grouped).toContainText("одно сообщение на пакет");

  // 5. Тестовый адаптер очереди получил то же сообщение.
  type Message = { userId: string; kind: string; batch: boolean; entries: unknown[] };
  const outbox = (await api<{ items: Message[] }>(page, "GET", "/api/v1/notifications/test-outbox")).items;
  const forAnna = outbox.filter((message) => message.userId === who("anna").id && message.kind === "status_changed");
  expect(forAnna.filter((message) => message.batch && message.entries.length === 30)).toHaveLength(1);

  // Переход по уведомлению — поиск по ключам пакета, уведомление прочитано.
  await grouped.getByRole("button").click();
  await expect(anna).toHaveURL(/\/search\?q=key/);
  await expect(anna.getByText("Найдено: 30")).toBeVisible();
  await anna.context().close();
  await ben.context().close();
});
