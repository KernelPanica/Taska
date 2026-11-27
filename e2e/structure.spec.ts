import { expect, test, type Page } from "@playwright/test";

/**
 * YT-02, «что показать команде»: суперадмин заводит команду Жабы, колодец ГД с лидом
 * и человека в двух командах; смена лида переживает перезагрузку; измерение-список без разработчика.
 */
async function signInAsSuperadmin(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Войти через YourSpace" }).click();
  await page.getByLabel("Логин / Login").fill("admin");
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
  await page.getByLabel("Код / Code").fill("123456");
  await page.getByRole("button", { name: "Подтвердить / Verify" }).click();
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
}

/** Людей заводят в каталоге YourSpace (YT-03); в разработке это страница заглушки. */
async function addToCatalog(page: Page, login: string, fullName: string) {
  await page.goto("/dev/yourspace/people");
  await page.getByLabel("ФИО").fill(fullName);
  await page.getByLabel("Логин YourSpace").fill(login);
  await page.getByRole("button", { name: "Завести" }).click();
  await expect(page.getByRole("heading", { name: fullName })).toBeVisible();
}

async function nav(page: Page, name: string) {
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

test("superadmin builds the team structure", async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await signInAsSuperadmin(page);
  for (const name of ["Дирекция", "Core", "Инфраструктура", "Производство"]) {
    await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
  }

  // Человек-лид для ГД и человек для двух команд — заводятся в каталоге YourSpace.
  await addToCatalog(page, "galina", "Галина Дизайн");
  await addToCatalog(page, "petr-double", "Пётр Двойной");
  await page.goto("/");

  // Команда Жабы.
  await nav(page, "Фичекоманды");
  await page.getByLabel("Название").fill("Жабы");
  await page.getByRole("button", { name: "Новая фичекоманда" }).click();
  await expect(page.getByRole("heading", { name: "Жабы" })).toBeVisible();

  // Колодец ГД с лидом; смена лида сохраняется после перезагрузки.
  await nav(page, "Колодцы");
  await page.getByLabel("Название").fill("ГД");
  await page.getByRole("button", { name: "Новый колодец" }).click();
  await expect(page.getByRole("heading", { name: "ГД" })).toBeVisible();
  await page.getByLabel("Лид").selectOption({ label: "Галина Дизайн" });
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Лид")).toHaveValue(
    (await page.getByLabel("Лид").locator("option", { hasText: "Галина Дизайн" }).getAttribute("value")) as string,
  );
  await page.getByLabel("Лид").selectOption({ label: "Нина Аналитик" });
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Лид").locator("option:checked")).toHaveText("Нина Аналитик");

  // Человек в двух командах и ни в одном колодце.
  await nav(page, "Люди");
  await page.getByRole("link", { name: "Пётр Двойной" }).click();
  const teams = page.getByRole("group", { name: /Фичекоманды/ });
  await teams.getByLabel("Жабы").check();
  await teams.getByLabel("Совы").check();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("group", { name: /Фичекоманды/ }).getByLabel("Жабы")).toBeChecked();
  await expect(page.getByRole("group", { name: /Фичекоманды/ }).getByLabel("Совы")).toBeChecked();
  await expect(page.getByRole("group", { name: /Колодцы/ }).getByRole("checkbox", { checked: true })).toHaveCount(0);

  // Измерение-список с множественным выбором — без разработчика.
  await nav(page, "Измерения");
  // R-2.14: «Фичекоманда» — одиночный выбор, «Стрим» — множественный, значения — колодцы.
  await expect(page.getByRole("link", { name: /^Фичекоманда .*Одиночный/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Стрим .*Колодцы.*Множественный/ })).toBeVisible();
  await page.getByLabel("Название").fill("Платформа");
  await page.getByLabel("Значения списка").fill("iOS\nAndroid\nWeb");
  await page.getByLabel("Множественный").check();
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("link", { name: /Платформа.*Множественный.*iOS, Android, Web/ })).toBeVisible();
});

test("a regular user does not see the test structure", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Войти через YourSpace" }).click();
  await page.getByLabel("Логин / Login").fill("vera");
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
  await nav(page, "Колодцы");
  await expect(page.getByText("Колодцев пока нет")).toBeVisible();
  await expect(page.getByText("Изменять справочники может только суперадмин.")).toBeVisible();
});
