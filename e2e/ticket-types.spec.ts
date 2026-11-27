import { expect, test, type Page } from "@playwright/test";

/**
 * YT-04, «что показать команде»: админ создаёт тип «Веха» со своим полем, шаблон и свою шкалу оценки,
 * открывает предпросмотр стори по шаблону «Стори». Плюс два шаблона у стори, ориентир в днях рядом с M,
 * свёртка в выбранной шкале и ограничитель подчинения, выключенный по умолчанию.
 */
async function signInAsSuperadmin(page: Page) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Войти через YourSpace" }).click();
  await page.getByLabel("Логин / Login").fill("admin");
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
  await page.getByLabel("Код / Code").fill("123456");
  await page.getByRole("button", { name: "Подтвердить / Verify" }).click();
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
}

async function nav(page: Page, name: string, heading = name) {
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("admin builds a type, a template and a scale without a developer", async ({ page }) => {
  await signInAsSuperadmin(page);

  // Стартовые типы есть сразу после установки.
  await nav(page, "Типы тикетов");
  for (const name of ["Цель", "Эпик", "Стори", "Задача", "Баг", "Реквест"]) {
    await expect(page.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
  }

  // Своя шкала оценки.
  await nav(page, "Шкалы оценки");
  const builder = page.locator(".ui-card", { has: page.getByRole("heading", { name: "Новая шкала" }) });
  await builder.getByLabel("Название").fill("Очки");
  await builder.getByLabel("Вид шкалы").selectOption("numeric");
  await builder.getByLabel("Единица").fill("очк.");
  await builder.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("heading", { name: "Очки", level: 2 })).toBeVisible();
  // В конвертере появилась строка «1 очк.»; задаём её и сохраняем.
  await page.getByLabel("Очки: 1 очк.: От, дн.").fill("0.5");
  await page.getByLabel("Очки: 1 очк.: До, дн.").fill("1");
  await page.locator(".converter").getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();

  // Своё поле.
  await nav(page, "Поля");
  await page.getByLabel("Название").fill("Платформа релиза");
  await page.getByLabel("Вид", { exact: true }).selectOption("list");
  await page.getByLabel("Значения списка").fill("Steam\nPlayStation\nXbox");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("heading", { name: "Платформа релиза" })).toBeVisible();
  await expect(page.getByText("platforma_reliza")).toBeVisible();

  // Тип «Веха» с цветом, иконкой и своим полем.
  await nav(page, "Типы тикетов");
  await page.getByLabel("Название").fill("Веха");
  await page.getByRole("button", { name: "Новый тип" }).click();
  await expect(page.getByRole("heading", { name: "Веха", level: 1 })).toBeVisible();
  await page.getByLabel("Цвет").fill("#0ea5e9");
  await page.getByLabel("Иконка").selectOption("flag-banner");
  const fieldsPicker = page.getByRole("group", { name: /Поля типа/ });
  await fieldsPicker.getByLabel("Платформа релиза").check();
  await fieldsPicker.getByLabel("Срок").check();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Иконка")).toHaveValue("flag-banner");
  await expect(page.getByLabel("Цвет")).toHaveValue("#0ea5e9");
  await expect(page.locator(".order-list li")).toHaveText([/Платформа релиза/, /Срок/]);

  // Шаблон вехи.
  await page.getByLabel("Название шаблона").fill("Релиз");
  await page.getByRole("button", { name: "Новый шаблон" }).click();
  await expect(page.getByRole("heading", { name: "Шаблон: Релиз" })).toBeVisible();
  await page.getByLabel("Структура описания").fill("## Что выходит\n- \n\n## Чеклист релиза\n1. ");
  await page.getByLabel("Платформа релиза").selectOption({ label: "Steam" });
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await expect(page.getByLabel("Предпросмотр").getByRole("heading", { name: "Что выходит" })).toBeVisible();
});

test("story: two templates with previews, M with a day guide, rollup in the chosen scale", async ({ page }) => {
  await signInAsSuperadmin(page);
  await nav(page, "Типы тикетов");
  await page.getByRole("link", { name: /^Стори/ }).click();
  await page.getByLabel("Название шаблона").fill("Стори арта");
  await page.getByRole("button", { name: "Новый шаблон" }).click();
  await page.getByLabel("Структура описания").fill("## Референсы\n- \n\n## Что рисуем\n");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await expect(page.getByLabel("Предпросмотр").getByRole("heading", { name: "Референсы" })).toBeVisible();

  // Второй шаблон — стартовый «Стори»: другая структура.
  await page.getByRole("link", { name: "Назад" }).click();
  await page.getByRole("link", { name: "Стори", exact: true }).click();
  const preview = page.getByLabel("Предпросмотр");
  for (const section of [
    "Задача",
    "Документы",
    "Цели",
    "Требования",
    "Список контента",
    "Шаги производства",
    "Критерии приёмки",
  ]) {
    await expect(preview.getByRole("heading", { name: section, exact: true })).toBeVisible();
  }

  // Две оценки: M и 6 дней; рядом с M — ориентир из конвертера.
  await page.getByLabel("Размер").selectOption({ label: "M" });
  await page.getByLabel("Оценка в днях, дн.").fill("6");
  await expect(preview.getByText("≈ 3–5 дн., ориентир").first()).toBeVisible();
  await expect(preview.getByText("6 дн.", { exact: true })).toBeVisible();
  await expect(preview.getByRole("status")).toHaveText(/^L · ≈ 6–10 дн\., ориентир/);
  await preview.getByLabel("Считать в шкале").selectOption({ label: "Дни" });
  await expect(preview.getByRole("status")).toHaveText("≈ 12 дн.");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
});

test("parent rules are off by default and switch on per space", async ({ page }) => {
  await signInAsSuperadmin(page);
  await page.getByRole("link", { name: /^Core/ }).click();
  const toggle = page.getByLabel("Ограничители подчинения");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(page.getByLabel("Ограничители подчинения")).toBeChecked();
  await page.getByRole("link", { name: "Конвертер оценок пространства" }).click();
  await expect(page.getByText("У пространства нет своего конвертера")).toBeVisible();
  await page.getByRole("button", { name: "Завести свой конвертер" }).click();
  await page.getByLabel("Майки: M: До, дн.").fill("6");
  await page.locator(".converter").getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await expect(page.getByRole("button", { name: "Вернуть конвертер по умолчанию" })).toBeVisible();
});
