import { expect, test, type Page } from "@playwright/test";

/**
 * YT-05: админ открывает схему стори, показывает категории и статусы-буферы, добавляет обязательное поле на входе в To Do.
 * YT-06: ПМ создаёт стори по шаблону «Стори» → заполняет поля и чеклист → назначает двух исполнителей →
 * двигает статус → отменяет другую стори с причиной.
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

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("admin shows the story scheme and adds a required field on entry to To Do", async ({ page }) => {
  await signIn(page, "admin", "123456");
  await page.getByRole("navigation").getByRole("link", { name: "Типы тикетов", exact: true }).click();
  await page.getByRole("link", { name: /^Стори/ }).click();
  await page.getByRole("link", { name: "Открыть схему статусов" }).click();
  await expect(page.getByRole("heading", { name: "Схема статусов: Стори" })).toBeVisible();

  // Категории и буферы из R-5.1.
  const statuses = page.locator(".scheme-status");
  await expect(statuses).toHaveCount(14);
  const card = (name: string) => statuses.filter({ has: page.locator(`input[value="${name}"]`) });
  await expect(card("Backlog").getByLabel("Категория")).toHaveValue("queue");
  await expect(card("Creation").getByLabel("Категория")).toHaveValue("in_progress");
  await expect(card("Done").getByLabel("Категория")).toHaveValue("done");
  await expect(card("Discovery Done").getByLabel("Ожидание (буфер)")).toBeChecked();
  await expect(card("Creation Done").getByLabel("Ожидание (буфер)")).toBeChecked();
  await expect(card("Creation").getByLabel("Ожидание (буфер)")).not.toBeChecked();

  const toDo = card("To Do").getByRole("group", { name: "To Do: Обязательно на входе" });
  await expect(toDo.getByLabel("Размер")).toBeChecked();
  await toDo.getByLabel("Стрим").check();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator(".scheme-status")
      .filter({ has: page.locator('input[value="To Do"]') })
      .getByRole("group", { name: "To Do: Обязательно на входе" })
      .getByLabel("Стрим"),
  ).toBeChecked();

  // Статус без категории не сохраняется.
  await page.getByRole("button", { name: "Добавить статус" }).click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText(/Проверьте введённые данные/)).toBeVisible();
});

test("PM creates a story from the template, fills it, assigns two people, moves it, cancels another", async ({
  page,
}) => {
  await signIn(page, "anna");
  await page.getByRole("link", { name: /Тестовое пространство/ }).click();

  // Стори по шаблону «Стори».
  await page.getByLabel("Название нового тикета").fill("Жаба прыгает через лужу");
  await page.getByLabel("Тип").selectOption({ label: "Стори" });
  await page.getByLabel("Шаблон").selectOption({ label: "Стори" });
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Жаба прыгает через лужу" })).toBeVisible();
  const key = (await page.locator(".ticket-header .ticket-key").textContent()) ?? "";
  expect(key).toMatch(/^AOS-\d+$/);
  await expect(page.getByRole("heading", { name: "Критерии приёмки" })).toBeVisible();

  // Чеклист: отмечаем пункт и добавляем свой.
  await page.getByRole("checkbox", { name: "Документы по ссылкам прочитаны" }).check();
  await expect(page.locator(".ticket-section__head").getByText("1 из 3", { exact: true })).toBeVisible();
  await page.getByLabel("Новый пункт").fill("Звук согласован");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  // Счётчик чеклиста (у стори он же и в полосе прогресса — YT-10).
  await expect(page.locator(".ticket-section__head").getByText("1 из 4")).toBeVisible();

  // Поля и два исполнителя.
  const assignees = page.getByRole("group", { name: /Исполнители/ });
  await assignees.getByLabel("Анна Тестова").check();
  await assignees.getByLabel("Ben Tester").check();
  await page.getByLabel("Приоритет").selectOption("high");
  await page.getByLabel("Теги").fill("арт, анимация");
  await page.getByLabel("Размер").selectOption({ label: "M" });
  await page.getByLabel("Оценка в днях, дн.").fill("6");
  await page.getByLabel("Срок").fill("2026-12-20");
  await page.getByLabel("Начало").fill("2026-12-10");
  await page.getByLabel("Окончание").fill("2026-12-01");
  await expect(page.getByText("Окончание раньше начала — проверьте даты.")).toBeVisible();
  await page.getByLabel("Окончание").fill("2026-12-25");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();

  // После перезагрузки всё на месте.
  await page.reload();
  await expect(page.getByRole("group", { name: /Исполнители/ }).getByLabel("Анна Тестова")).toBeChecked();
  await expect(page.getByRole("group", { name: /Исполнители/ }).getByLabel("Ben Tester")).toBeChecked();
  await expect(page.getByLabel("Приоритет")).toHaveValue("high");
  await expect(page.getByLabel("Теги")).toHaveValue("арт, анимация");
  await expect(page.getByLabel("Оценка в днях, дн.")).toHaveValue("6");
  await expect(page.getByRole("checkbox", { name: "Звук согласован" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Документы по ссылкам прочитаны" })).toBeChecked();

  // Статус: Discovery требует исполнителя и срок — заполнено, переходим.
  await page.getByLabel("Перевести в").selectOption({ label: "Discovery" });
  await page.getByRole("button", { name: "Перевести" }).click();
  await expect(page.locator(".ticket-header").getByText("Discovery", { exact: true })).toBeVisible();
  // To Do требует ещё и стрим (его добавил админ) — понятная ошибка.
  await page.getByLabel("Перевести в").selectOption({ label: "To Do" });
  await page.getByRole("button", { name: "Перевести" }).click();
  await expect(page.getByRole("alert")).toContainText("Чтобы перейти в «To Do», заполните:");

  // Другую стори отменяем с причиной.
  await page.locator(".back-link").click();
  await page.getByLabel("Название нового тикета").fill("Лишняя стори");
  await page.getByLabel("Тип").selectOption({ label: "Стори" });
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Лишняя стори" })).toBeVisible();
  const second = (await page.locator(".ticket-header .ticket-key").textContent()) ?? "";
  expect(Number(second.split("-")[1])).toBe(Number(key.split("-")[1]) + 1);
  await page.getByLabel("Причина отмены").fill("Дублирует жабу");
  await page.getByRole("button", { name: "Отменить тикет" }).click();
  await expect(page.getByText("Отменён: Дублирует жабу")).toBeVisible();
  await expect(page.getByText("Исход: Отменено")).toBeVisible();

  // В архив и обратно — со статусом Done.
  await page.getByLabel("Причина архива").selectOption("done");
  await page.getByRole("button", { name: "В архив" }).click();
  await expect(page.getByText(/В архиве: выполнено/)).toBeVisible();
  await page.locator(".back-link").click();
  await expect(page.getByRole("link", { name: "Лишняя стори" })).toHaveCount(0);
  await page.getByLabel("Показать архив").check();
  await page.getByRole("link", { name: "Лишняя стори" }).click();
  await page.getByRole("button", { name: "Вернуть из архива" }).click();
  await expect(page.locator(".ticket-header").getByText("Done", { exact: true })).toBeVisible();

  // Открытие кликом по свободной части карточки в списке.
  await page.locator(".back-link").click();
  await page.locator(".ticket-card", { hasText: "Жаба прыгает через лужу" }).click({ position: { x: 400, y: 10 } });
  await expect(page.getByRole("heading", { level: 1, name: "Жаба прыгает через лужу" })).toBeVisible();
});
