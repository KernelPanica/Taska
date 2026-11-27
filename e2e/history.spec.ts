import { expect, test, type Page } from "@playwright/test";

/**
 * YT-07, «что показать команде»: несколько правок тикета → вкладка «Действия» →
 * комментарий с упоминанием → задача из комментария.
 */
async function signIn(page: Page, login: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Войти через YourSpace" }).click();
  await page.getByLabel("Логин / Login").fill(login);
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("edits show up in Actions; a comment mentions a person and a ticket; a task is made from it", async ({ page }) => {
  await signIn(page, "anna");
  await page.getByRole("link", { name: /Тестовое пространство/ }).click();

  // Тикет, на который сошлёмся из комментария.
  await page.getByLabel("Название нового тикета").fill("Звуки прыжка");
  await page.getByLabel("Тип").selectOption({ label: "Задача" });
  await page.getByRole("button", { name: "Создать" }).click();
  const other = (await page.locator(".ticket-header .ticket-key").textContent()) ?? "";
  await page.locator(".back-link").click();

  await page.getByLabel("Название нового тикета").fill("Жаба ныряет");
  await page.getByLabel("Тип").selectOption({ label: "Стори" });
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Жаба ныряет" })).toBeVisible();

  // Несколько правок.
  await page
    .getByRole("group", { name: /Исполнители/ })
    .getByLabel("Ben Tester")
    .check();
  await page.getByLabel("Приоритет").selectOption("high");
  await page.getByLabel("Размер").selectOption({ label: "M" });
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page
    .getByRole("group", { name: /Исполнители/ })
    .getByLabel("Ben Tester")
    .uncheck();
  await page
    .getByRole("group", { name: /Исполнители/ })
    .getByLabel("Анна Тестова")
    .check();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();

  // Вкладка «Действия»: кто, когда, было → стало.
  await page.getByRole("tab", { name: "Действия" }).click();
  const log = page.locator(".history-list");
  await expect(log).toContainText("Приоритет: обычный → высокий");
  await expect(log).toContainText("Размер: пусто → M");
  await expect(log).toContainText("Исполнители: пусто → Ben Tester");
  await expect(log).toContainText("Исполнители: Ben Tester → Анна Тестова");
  await expect(log).toContainText("Создан: Жаба ныряет");
  await expect(log.locator(".history-list__when").first()).toContainText("Анна Тестова");

  // Комментарий с упоминанием человека и тикета.
  await page.getByRole("tab", { name: /Комментарии/ }).click();
  const field = page.getByLabel("Комментарий", { exact: true });
  await field.fill(`Нужен звук, см. ${other}. `);
  await field.pressSequentially("@be");
  await page.getByRole("button", { name: /@ben/ }).click();
  await field.pressSequentially("озвучишь?");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByRole("tab", { name: "Комментарии · 1" })).toBeVisible();
  const comment = page.locator(".comment").first();
  await expect(comment.getByRole("link", { name: "@Ben Tester" })).toBeVisible();
  await expect(comment.getByRole("link", { name: other })).toBeVisible();

  // Задача из комментария; комментарий показывает её статус.
  await comment.getByRole("button", { name: "Сделать тикетом" }).click();
  await comment.getByLabel("Название задачи").fill("Озвучить прыжок жабы");
  await comment.getByLabel("Исполнитель").selectOption({ label: "Ben Tester" });
  await comment.getByRole("button", { name: "Создать задачу" }).click();
  await expect(comment.getByText("Backlog")).toBeVisible();
  await comment.getByRole("link", { name: /^Задача AOS-/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Озвучить прыжок жабы" })).toBeVisible();
  await expect(page.locator(".md-preview blockquote")).toContainText("Нужен звук");
  await expect(page.getByRole("link", { name: /^AOS-\d+$/ }).first()).toBeVisible();

  // Упоминание тикета ведёт по ссылке.
  await page.goBack();
  await page.locator(".comment").first().getByRole("link", { name: other }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Звуки прыжка" })).toBeVisible();
});
