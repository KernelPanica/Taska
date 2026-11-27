import { expect, test, type Page } from "@playwright/test";

/**
 * «Что показать команде»: чистая установка → вход аккаунтом YourSpace →
 * пустое пространство → переключение языка. Плюс Google, вторая проверка админа и отзыв сессии.
 */

async function signInWithPassword(page: Page, login: string, otp?: string) {
  await page.goto("/");
  await page.getByRole("link", { name: /Войти через YourSpace|Sign in with YourSpace/ }).click();
  await expect(page.getByRole("heading", { name: "Вход в YourSpace" })).toBeVisible();
  await page.getByLabel("Логин / Login").fill(login);
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
  if (otp) {
    await expect(page.getByRole("heading", { name: "Вторая проверка входа" })).toBeVisible();
    await page.getByLabel("Код / Code").fill(otp);
    await page.getByRole("button", { name: "Подтвердить / Verify" }).click();
  }
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("clean install → YourSpace sign-in → space → RU ↔ EN", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Вход в YourTask" })).toBeVisible();

  await signInWithPassword(page, "anna");
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
  await page.getByRole("link", { name: /Тестовое пространство/ }).click();
  await expect(page.getByRole("heading", { name: "Тикеты", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  // Язык хранится в профиле: после перезагрузки и очистки браузерного хранилища он остаётся.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "RU", exact: true }).click();
  await expect(page.getByRole("link", { name: "Профиль", exact: true })).toBeVisible();
});

test("sign-in with the linked Google account", async ({ page }) => {
  // The method belongs to YourSpace; YourTask's UI exposes only its unified entry.
  await page.goto("/api/v1/auth/login?method=google");
  await page.getByRole("button", { name: "anna.test@gmail.test" }).click();
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
  await page.getByRole("link", { name: "Сессии" }).click();
  await expect(page.getByText("Google", { exact: false }).first()).toBeVisible();
});

test("administrator signs in with a second check", async ({ page }) => {
  await signInWithPassword(page, "admin", "123456");
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Настройка тикетов", exact: true })).toBeVisible();
  const current = await (await page.request.get("/api/v1/me")).json();
  expect(current).toMatchObject({ user: { role: "superadmin" }, session: { mfa: true } });
});

test("administrator without a second factor is refused", async ({ page }) => {
  await signInWithPassword(page, "admin-no2fa");
  await expect(page.getByRole("heading", { name: "Вторая проверка не настроена" })).toBeVisible();
  await page.getByRole("button", { name: "Вернуться в YourTask" }).click();
  await expect(page.getByRole("alert")).toContainText("Суперадмину и админам нужна вторая проверка");
});

test("a session is revoked from another device", async ({ browser }) => {
  const laptop = await browser.newPage();
  const phone = await browser.newPage({ storageState: undefined });
  await signInWithPassword(laptop, "ben");
  await signInWithPassword(phone, "ben");

  // У ben в профиле английский — интерфейс берёт язык из профиля.
  await laptop.goto("/settings/sessions");
  await expect(laptop.getByRole("button", { name: "Revoke" })).toHaveCount(1);
  await laptop.getByRole("button", { name: "Revoke" }).click();
  await expect(laptop.getByText("Session revoked")).toBeVisible();

  await phone.reload();
  await expect(phone.getByRole("heading", { name: "Sign in to YourTask" })).toBeVisible();
});

test("API serves the test space and documents itself", async ({ request }) => {
  const health = await request.get("/health");
  expect(await health.json()).toMatchObject({ status: "ok", database: "ok" });
  const unauthenticated = await request.get("/api/v1/spaces");
  expect(unauthenticated.status()).toBe(401);
  expect(await unauthenticated.json()).toMatchObject({ code: "unauthenticated", status: 401 });
  const spec = await (await request.get("/api/openapi.json")).json();
  expect(spec.paths).toHaveProperty(["/api/v1/spaces"]);
});

test("sign out is available only in the current person's profile", async ({ page }) => {
  await signInWithPassword(page, "anna");
  await expect(page.getByRole("button", { name: /^(Выйти|Sign out)$/ })).toHaveCount(0);
  await expect(page.locator(".app-sidebar__account")).toHaveCount(0);
  const current = await (await page.request.get("/api/v1/me")).json();
  const people = await (await page.request.get("/api/v1/people")).json();
  const other = people.items.find((person: { id: string }) => person.id !== current.user.id);
  expect(other).toBeTruthy();
  await page.goto(`/people/${other.id}`);
  await expect(page.getByRole("heading", { level: 1, name: other.name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Выйти|Sign out)$/ })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: /^(Навигация|Navigation)$/ })
    .getByRole("link", { name: /^(Профиль|Profile)$/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: current.user.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^(Выйти|Sign out)$/ }).click();
  await expect(page.getByRole("heading", { name: /^(Вход в YourTask|Sign in to YourTask)$/ })).toBeVisible();
  expect((await page.request.get("/api/v1/me")).status()).toBe(401);
});
