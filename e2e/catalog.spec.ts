import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * YT-03, «что показать команде»: админ заводит человека в YourSpace → его назначают в YourTask →
 * смена Telegram видна → деактивация → вход закрыт, имя и участие в команде остались.
 * Плюс отчёт сопоставления людей, заведённых до перехода, — до нуля неразобранных строк.
 * В разработке YourSpace — встроенная заглушка (/dev/yourspace), каталог синхронизируется сразу.
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
}

async function newPage(browser: Browser) {
  const context = await browser.newContext({ locale: "ru-RU" });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  return page;
}

test("catalog member: added in YourSpace, assigned in YourTask, deactivated", async ({ browser }) => {
  // 1. Админ YourSpace заводит человека.
  const yourspace = await newPage(browser);
  await yourspace.goto("/dev/yourspace/people");
  await yourspace.getByLabel("ФИО").fill("Захар Новичков");
  await yourspace.getByLabel("Логин YourSpace").fill("zakhar");
  await yourspace.getByLabel("Почта").fill("zakhar@yourspace.test");
  await yourspace.getByLabel("Telegram").fill("@zakhar_old");
  await yourspace.getByLabel("Телефон").fill("+7 900 123-45-67");
  await yourspace.getByLabel("Дата рождения").fill("1998-03-14");
  await yourspace.getByRole("button", { name: "Завести" }).click();
  await expect(yourspace.getByRole("heading", { name: "Захар Новичков" })).toBeVisible();

  // 2. В YourTask он сразу есть; суперадмин ставит его в команду Совы.
  const admin = await newPage(browser);
  await signIn(admin, "admin", "123456");
  await admin.getByRole("navigation").getByRole("link", { name: "Люди", exact: true }).click();
  await admin.getByRole("link", { name: "Захар Новичков" }).click();
  await expect(admin.getByRole("heading", { name: "Профиль YourSpace" })).toBeVisible();
  await expect(admin.getByRole("link", { name: "@zakhar_old" })).toBeVisible();
  // Телефон и дату рождения не видит даже суперадмин — только маской.
  await expect(admin.getByText("+… 67")).toBeVisible();
  await expect(admin.getByText("123-45-67")).toHaveCount(0);
  await expect(admin.getByText("1998-03-14")).toHaveCount(0);
  await admin
    .getByRole("group", { name: /Фичекоманды/ })
    .getByLabel("Совы")
    .check();
  await admin.getByRole("button", { name: "Сохранить" }).click();
  await expect(admin.getByText("Сохранено")).toBeVisible();

  // 3. Смена Telegram в профиле YourSpace видна в карточке YourTask.
  await yourspace.getByLabel("Telegram").fill("@zakhar_new");
  await yourspace.getByRole("button", { name: "Сохранить" }).click();
  await admin.reload();
  await expect(admin.getByRole("link", { name: "@zakhar_new" })).toBeVisible();

  // 4. Захар входит в YourTask.
  const zakhar = await newPage(browser);
  await signIn(zakhar, "zakhar");
  await expect(zakhar.getByRole("heading", { name: "Пространства" })).toBeVisible();

  // 5. Деактивация в YourSpace закрывает вход сразу.
  await yourspace.getByRole("button", { name: "Деактивировать" }).click();
  await expect(yourspace.getByText("деактивирован")).toBeVisible();
  await zakhar.reload();
  await expect(zakhar.getByRole("heading", { name: "Вход в YourTask" })).toBeVisible();
  await signIn(zakhar, "zakhar");
  await expect(zakhar.getByText("Неверный логин или пароль")).toBeVisible();

  // 6. История цела: карточка с именем и командой, в составе Сов — с пометкой.
  await admin.reload();
  await expect(admin.getByRole("heading", { name: "Захар Новичков" })).toBeVisible();
  await expect(admin.getByText("Деактивирован в каталоге YourSpace")).toBeVisible();
  await expect(admin.getByRole("group", { name: /Фичекоманды/ }).getByLabel("Совы")).toBeChecked();
  await admin.getByRole("navigation").getByRole("link", { name: "Фичекоманды", exact: true }).click();
  await admin.getByRole("link", { name: /^Совы/ }).click();
  await expect(admin.getByRole("group", { name: /Состав/ }).getByLabel("Захар Новичков · деактивирован")).toBeChecked();
  // В списке людей для назначения его нет; с галочкой «Показать деактивированных» — есть.
  await admin.getByRole("navigation").getByRole("link", { name: "Люди", exact: true }).click();
  await expect(admin.getByRole("link", { name: "Анна Тестова" })).toBeVisible();
  await expect(admin.getByRole("link", { name: "Захар Новичков" })).toHaveCount(0);
  await admin.getByLabel("Показать деактивированных").check();
  await expect(admin.getByRole("link", { name: "Захар Новичков" })).toBeVisible();
});

test("matching report: people added before the catalog end with no unresolved rows", async ({ browser }) => {
  const admin = await newPage(browser);
  await signIn(admin, "admin", "123456");
  await admin.goto("/people/catalog-report");
  await expect(admin.getByRole("heading", { name: "Сопоставление с каталогом" })).toBeVisible();
  await expect(admin.getByText("Неразобранных строк: 1")).toBeVisible();
  const row = admin.getByRole("row", { name: /Пётр Старожил/ });
  await expect(row.getByLabel("Связать с")).toHaveValue("ys-test-petr");
  await row.getByRole("button", { name: "Связать" }).click();
  await expect(admin.getByText("Неразобранных строк нет.")).toBeVisible();
  await expect(admin.getByRole("row", { name: /Пётр Старожилов.*вручную/ })).toBeVisible();
});
