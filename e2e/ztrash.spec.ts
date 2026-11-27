import { expect, test, type Page } from "@playwright/test";

/**
 * YT-14, «что показать команде»: удаление эпика → «оставить детей» → восстановление из корзины.
 * Второй сценарий: окончательное удаление и пересвязка детей по следу.
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
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
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

/** Эпик с двумя детьми в тестовом пространстве. */
async function epicWithChildren(page: Page, title: string) {
  const spaces = await api<{ items: { id: string; slug: string }[] }>(page, "GET", "/api/v1/spaces");
  const spaceId = (spaces.items.find((space) => space.slug === "test") as { id: string }).id;
  const types = await api<{ items: { id: string; key: string }[] }>(page, "GET", "/api/v1/ticket-types");
  const typeId = (key: string) => (types.items.find((type) => type.key === key) as { id: string }).id;
  const create = (body: Record<string, unknown>) =>
    api<{ key: string }>(page, "POST", "/api/v1/tickets", { spaceId, typeId: typeId("story"), ...body });
  const epic = await create({ typeId: typeId("epic"), title });
  const camera = await create({ title: `${title}: камера`, parentKey: epic.key });
  const sound = await create({ title: `${title}: звук`, parentKey: epic.key });
  return { spaceId, typeId, epic, camera, sound };
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("deleting an epic → «keep the children» → restoring it from the trash with every link", async ({ page }) => {
  await signIn(page, "anna");
  const { epic, camera, sound } = await epicWithChildren(page, "Прототип боя");

  await page.goto(`/tickets/${epic.key}`);
  await page.getByRole("button", { name: "В корзину" }).click();
  const dialog = page.getByRole("dialog", { name: "Что сделать с детьми?" });
  await expect(dialog.getByRole("radio", { name: /Оставить без этой связи/ })).toBeChecked();
  await dialog.getByRole("button", { name: "В корзину" }).click();
  await expect(page).toHaveURL(/\/spaces\/test$/);
  await expect(page.getByRole("status").filter({ hasText: `${epic.key} «Прототип боя» в корзине` })).toBeVisible();

  // У ребёнка — след родителя и строка в истории.
  await page.goto(`/tickets/${camera.key}`);
  const trace = page.getByRole("region", { name: "След родителя" });
  await expect(trace).toContainText(`${epic.key} «Прототип боя» · удалён`);
  await expect(trace).toContainText("ещё тикетов с этим следом: 1");
  await page.getByRole("tab", { name: "Действия" }).click();
  await expect(
    page.locator(".history-list").getByText(`Родитель ${epic.key} Прототип боя удалён, связь снята, след сохранён`),
  ).toBeVisible();

  // Корзина → «Восстановить»: эпик возвращается с детьми.
  await page.getByRole("navigation").getByRole("link", { name: "Корзина", exact: true }).click();
  const item = page.locator(".trash-item").filter({ hasText: epic.key });
  await expect(item).toContainText("вернётся связей: 2");
  await item.getByRole("button", { name: "Восстановить" }).click();
  await expect(page.getByText(`Восстановлено: ${epic.key}`)).toBeVisible();
  await page.goto(`/tickets/${epic.key}`);
  await expect(page.getByRole("heading", { level: 1, name: "Прототип боя" })).toBeVisible();
  const relations = page.locator(".relations");
  await expect(relations.getByText("Прототип боя: камера")).toBeVisible();
  await expect(relations.getByText("Прототип боя: звук")).toBeVisible();
  await page.goto(`/tickets/${sound.key}`);
  await expect(page.getByRole("region", { name: "След родителя" })).toHaveCount(0);
});

test("deleting for good keeps the key and the trace; parentTrace() finds the children; «Relink» binds them in one action", async ({
  page,
}) => {
  await signIn(page, "admin", "123456");
  const { spaceId, typeId, epic, camera, sound } = await epicWithChildren(page, "Старый прототип");
  await api(page, "POST", "/api/v1/tickets/trash", { keys: [epic.key], children: "keep" });

  // Досрочная очистка — суперадмин, с подтверждением прямо в строке.
  await page.goto("/trash");
  const item = page.locator(".trash-item").filter({ hasText: epic.key });
  await item.getByRole("button", { name: "Удалить навсегда" }).click();
  await item.getByRole("button", { name: "Да, удалить" }).click();
  await expect(page.locator(".trash-item").filter({ hasText: epic.key })).toHaveCount(0);
  await page.goto(`/tickets/${epic.key}`);
  await expect(page.getByText(/Ключ больше не будет выдан/)).toBeVisible();

  // Бывшие дети находятся функцией parentTrace() по ссылке со следа.
  await page.goto(`/tickets/${camera.key}`);
  const trace = page.getByRole("region", { name: "След родителя" });
  await expect(trace).toContainText("удалён окончательно");
  await trace.getByRole("link", { name: `parentTrace(${epic.key})` }).click();
  const list = page.locator(".ticket-list");
  await expect(list.locator(".ticket-card")).toHaveCount(2);
  await expect(list.getByText("Старый прототип: камера")).toBeVisible();
  await expect(list.getByText("Старый прототип: звук")).toBeVisible();

  // «Связать заново»: обоих — к новому эпику одним действием.
  const next = await api<{ key: string; number: number }>(page, "POST", "/api/v1/tickets", {
    spaceId,
    typeId: typeId("epic"),
    title: "Новый прототип",
  });
  expect(Number(next.key.split("-")[1])).toBeGreaterThan(Number(epic.key.split("-")[1]));
  await page.goto(`/tickets/${sound.key}`);
  await trace.getByRole("button", { name: "Связать заново" }).click();
  await trace.getByLabel(/Новый родитель/).fill(next.key);
  await trace.getByRole("button", { name: "Связать всех (2)" }).click();
  await expect(page.getByText("Связано заново: 2.")).toBeVisible();
  await page.goto(`/tickets/${next.key}`);
  await expect(page.locator(".relations").getByText("Старый прототип: камера")).toBeVisible();
  await expect(page.locator(".relations").getByText("Старый прототип: звук")).toBeVisible();
});
