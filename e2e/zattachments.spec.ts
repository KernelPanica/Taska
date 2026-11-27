import { expect, test, type Page } from "@playwright/test";

/**
 * YT-13, «что показать команде»: загрузка видео и скриншота → вставка в описание → попытка загрузить
 * слишком большой файл. Плюс докачка после обрыва и подменённое расширение.
 */
async function signIn(page: Page, login: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Войти через YourSpace" }).click();
  await page.getByLabel("Логин / Login").fill(login);
  await page.getByLabel("Пароль / Password").fill("yourspace");
  await page.getByRole("button", { name: "Войти / Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Пространства" })).toBeVisible();
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);
const mp4 = (size: number) => {
  const data = Buffer.alloc(size, 1);
  data.write("ftypisom", 4, "latin1");
  return data;
};

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("a video and a screenshot are attached and inserted into the description; a too big file is refused before uploading", async ({
  page,
}) => {
  await signIn(page, "anna");
  await page.goto("/spaces/test");
  await page.getByLabel("Название нового тикета").fill("Камера дёргается при переключении");
  await page.getByLabel("Тип").selectOption({ label: "Баг" });
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Камера дёргается при переключении" })).toBeVisible();

  // Большое видео: связь рвётся на второй части — загрузка продолжается с места обрыва.
  let broken = false;
  const offsets: number[] = [];
  await page.route("**/api/v1/uploads/*?offset=*", async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    offsets.push(offset);
    if (offset > 0 && !broken) {
      broken = true;
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page.getByLabel("Прикрепить файл").setInputFiles([
    { name: "запись бага.mp4", mimeType: "video/mp4", buffer: mp4(9 * 1024 * 1024) },
    { name: "скриншот.png", mimeType: "image/png", buffer: PNG },
  ]);
  const attachments = page.getByRole("region", { name: "Вложения" });
  await expect(attachments.getByRole("img", { name: "скриншот.png" })).toBeVisible({ timeout: 30_000 });
  await expect(attachments.locator("video")).toHaveCount(1);
  // Первая часть не повторялась: после обрыва — с того же места, не с нуля.
  expect(offsets.filter((offset) => offset === 0)).toHaveLength(2); // видео и скриншот — по одному разу
  expect(broken).toBe(true);
  await page.unroute("**/api/v1/uploads/*?offset=*");

  // Видео играет в карточке: браузер получает его по Range.
  const source = await attachments.locator("video").getAttribute("src");
  const range = await page.request.get(source as string, { headers: { range: "bytes=4-11" } });
  expect(range.status()).toBe(206);
  expect(await range.text()).toBe("ftypisom");

  // Вставка в описание одним нажатием.
  await attachments.getByRole("button", { name: "Вставить «запись бага.mp4» в описание" }).click();
  await expect(page.locator(".ticket-section .md-preview video.md-media")).toHaveCount(1);

  // История: загрузка видна.
  await page.getByRole("tab", { name: "Действия" }).click();
  await expect(page.locator(".history-list").getByText("Прикреплён файл «запись бага.mp4»")).toBeVisible();

  // Слишком большой файл — понятная ошибка до начала загрузки, без 413. Лимит на файл здесь — 2 КБ
  // (лимит меняет админ; для сценария подменяем ответ с настройками, чтобы не грузить сотни мегабайт).
  const settings = await (await page.request.get("/api/v1/attachment-settings")).json();
  await page.route("**/api/v1/attachment-settings", (route) =>
    route.fulfill({ json: { ...settings, maxFileBytes: 2048 } }),
  );
  await page.reload();
  let started = false;
  page.on("request", (request) => {
    if (request.url().includes("/uploads")) started = true;
  });
  await page
    .getByLabel("Прикрепить файл")
    .setInputFiles({ name: "ещё больше.mp4", mimeType: "video/mp4", buffer: mp4(4096) });
  await expect(page.getByText(/«ещё больше\.mp4» больше 2 КБ/)).toBeVisible();
  expect(started).toBe(false);
  await page.unroute("**/api/v1/attachment-settings");

  // Подменённое расширение отклоняется.
  await page.getByLabel("Прикрепить файл").setInputFiles({
    name: "картинка.png",
    mimeType: "image/png",
    buffer: Buffer.from("<html><script>alert(1)</script></html>"),
  });
  await expect(page.getByText(/«картинка\.png»: содержимое не совпадает с расширением/)).toBeVisible();
});
