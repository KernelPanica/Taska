import { expect, test, type Page } from "@playwright/test";

/** YT-11, «что показать команде»: поток из 10 задач → вставка двух в середину → номера пересчитаны, ссылки целы. */
async function signIn(page: Page, login: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Войти через YourSpace" }).click();
  await page.getByLabel("Логин / Login").fill(login);
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
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

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("a flow of 10 tasks → two inserted in the middle → numbers recalculated, links by key intact", async ({
  page,
}) => {
  await signIn(page, "anna");
  const spaces = await api<{ items: { id: string; slug: string }[] }>(page, "GET", "/api/v1/spaces");
  const spaceId = (spaces.items.find((space) => space.slug === "test") as { id: string }).id;
  const types = await api<{ items: { id: string; key: string }[] }>(page, "GET", "/api/v1/ticket-types");
  const typeId = (key: string) => (types.items.find((type) => type.key === key) as { id: string }).id;
  const epic = await api<{ key: string }>(page, "POST", "/api/v1/tickets", {
    spaceId,
    typeId: typeId("epic"),
    title: "Поток релиза",
  });
  const keys: string[] = [];
  for (let index = 1; index <= 10; index += 1) {
    const task = await api<{ key: string }>(page, "POST", "/api/v1/tickets", {
      spaceId,
      typeId: typeId("task"),
      title: `Шаг ${index}`,
      parentKey: epic.key,
    });
    keys.push(task.key);
  }
  const sixth = keys[5] as string;
  // Ссылка по ключу на шестой шаг — в комментарии эпика.
  await page.goto(`/tickets/${epic.key}`);
  await page.getByLabel("Комментарий", { exact: true }).fill(`Не забыть ${sixth}`);
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.locator(".comment").getByRole("link", { name: sixth })).toBeVisible();

  // Вставка двух задач в середину: перед пятым шагом, одной строкой в карточке эпика.
  for (const title of ["Срочный фикс", "Ревью"]) {
    if (!(await page.getByRole("form", { name: "+ ребёнок" }).isVisible())) {
      await page.getByRole("button", { name: "+ ребёнок" }).click();
    }
    const form = page.getByRole("form", { name: "+ ребёнок" });
    await form.getByLabel("Куда").selectOption(keys[4] as string);
    await form.getByRole("textbox", { name: "+ ребёнок" }).fill(title);
    await form.getByRole("textbox", { name: "+ ребёнок" }).press("Enter");
    await expect(page.locator(".relation-list").getByText(title)).toBeVisible();
  }

  // Номера пересчитаны: вставленные — 1.5 и 1.6, бывший 1.5 стал 1.7, шестой шаг — 1.8.
  await page.goto(`/spaces/test/tree?root=${epic.key}`);
  const rows = page.locator(".tree-row");
  await expect(rows.filter({ hasText: "Срочный фикс" }).locator(".flow-number")).toHaveText(/\.5$/);
  await expect(rows.filter({ hasText: "Ревью" }).locator(".flow-number")).toHaveText(/\.6$/);
  await expect(rows.filter({ hasText: "Шаг 5" }).locator(".flow-number")).toHaveText(/\.7$/);
  await expect(rows.filter({ hasText: "Шаг 10" }).locator(".flow-number")).toHaveText(/\.12$/);

  // В истории сдвинутого — системная строка, а ссылка по ключу ведёт туда же.
  await page.goto(`/tickets/${sixth}`);
  await expect(page.getByRole("heading", { level: 1, name: "Шаг 6" })).toBeVisible();
  await page.getByRole("tab", { name: "Действия" }).click();
  await expect(page.locator(".history-list").getByText(/Номер \d+\.7 → \d+\.8, вставлен AOS-\d+/)).toBeVisible();
  await page.goto(`/tickets/${epic.key}`);
  await page.locator(".comment").getByRole("link", { name: sixth }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Шаг 6" })).toBeVisible();
  await expect(page.locator(".ticket-header .flow-number")).toHaveText(new RegExp(`\\.8 в ${epic.key}$`));
});
