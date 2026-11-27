import { expect, test, type Page } from "@playwright/test";

/**
 * YT-09 и YT-10, «что показать команде»:
 * эпик со стори → вставка уровня между ними → тикет получает второго родителя → над эпиком появляется цель;
 * эпик с детьми → один уходит в работу → все закрыты → флаг «закрыть?» → ПМ закрывает эпик.
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

async function newTicket(page: Page, title: string, type: string) {
  await page.goto("/spaces/test");
  await page.getByLabel("Название нового тикета").fill(title);
  await page.getByLabel("Тип").selectOption({ label: type });
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  return (await page.locator(".ticket-header .ticket-key").textContent()) ?? "";
}

/** «+ ребёнок» / «+ родитель» в карточке: одна строка, Enter — создан и связан. */
async function quick(page: Page, relation: "+ ребёнок" | "+ родитель", title: string, type: string) {
  const form = page.getByRole("form", { name: relation });
  if (!(await form.isVisible())) await page.getByRole("button", { name: relation }).click();
  await form.getByLabel("Тип").selectOption({ label: type });
  await form.getByRole("textbox", { name: relation }).fill(title);
  await form.getByRole("textbox", { name: relation }).press("Enter");
  await expect(page.locator(".relation-list").getByText(title)).toBeVisible();
}

test("an epic with stories → a level between them → a second parent → a goal above the epic", async ({ page }) => {
  await signIn(page, "anna");
  const epic = await newTicket(page, "Боевая система", "Эпик");
  await quick(page, "+ ребёнок", "Удар", "Стори");
  await quick(page, "+ ребёнок", "Блок", "Стори");

  // Вставка уровня: в дереве отмечаем обе стори и оборачиваем их в «Ближний бой».
  await page.goto(`/spaces/test/tree?root=${epic}`);
  await page
    .getByRole("checkbox", { name: /Выбрать AOS-\d+/ })
    .nth(2)
    .check();
  await page
    .getByRole("checkbox", { name: /Выбрать AOS-\d+/ })
    .nth(1)
    .check();
  await expect(page.getByText("Выбрано: 2")).toBeVisible();
  await page.getByLabel("Обернуть в родителя").fill("Ближний бой");
  await page.getByRole("button", { name: "Обернуть", exact: true }).click();
  const tree = page.getByRole("list", { name: "Дерево тикетов" });
  await expect(tree.getByText("Ближний бой")).toBeVisible();
  // Порядок строк: эпик → новый уровень → стори.
  await expect(tree.locator(".tree-row__title")).toHaveText(["Боевая система", "Ближний бой", "Удар", "Блок"]);

  // Второй родитель: «Удар» ещё и в «Интерфейсе боя».
  const ui = await newTicket(page, "Интерфейс боя", "Эпик");
  await page.goto(`/spaces/test/tree?root=${epic}`);
  await tree.getByRole("link", { name: /AOS-/ }).nth(2).click();
  await expect(page.getByRole("heading", { level: 1, name: "Удар" })).toBeVisible();
  // Единая форма «Добавить связь или родителя»: по умолчанию — родитель.
  await page.getByLabel("Ключ тикета").fill(ui);
  await page.getByRole("button", { name: "Связать" }).click();
  await expect(page.locator(".relation-list").first().getByText("Интерфейс боя")).toBeVisible();
  await page.goto("/spaces/test/tree");
  await expect(page.getByText("тот же тикет")).toBeVisible();

  // Над эпиком — цель; у «Удара» охват 1.
  await page.goto(`/tickets/${epic}`);
  await quick(page, "+ родитель", "Альфа к марту", "Цель");
  await page.goto("/spaces/test/tree");
  await expect(page.getByRole("list", { name: "Дерево тикетов" }).locator(".tree-row__title").first()).toBeVisible();
  await page.goto(`/tickets/${epic}`);
  await expect(page.getByText("охват: 1")).toBeVisible();
});

test("an epic with children → one goes to work → all closed → «close?» flag → the PM closes the epic", async ({
  page,
}) => {
  await signIn(page, "anna");
  const epic = await newTicket(page, "Эпик со свёрткой", "Эпик");
  await quick(page, "+ ребёнок", "Модель босса", "Задача");
  await quick(page, "+ ребёнок", "Звук босса", "Задача");
  const children = page.locator(".relation-list").last().getByRole("link", { name: /AOS-/ });
  const [first, second] = [await children.nth(0).textContent(), await children.nth(1).textContent()];

  const move = async (key: string | null, status: string) => {
    await page.goto(`/tickets/${key}`);
    await page.getByLabel("Перевести в").selectOption({ label: status });
    await page.getByRole("button", { name: "Перевести" }).click();
    await expect(page.locator(".ticket-header__meta").getByText(status, { exact: true })).toBeVisible();
  };

  await move(first, "Creation");
  await page.goto(`/tickets/${epic}`);
  await expect(page.locator(".ticket-header__meta").getByText("In Progress", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Действия" }).click();
  await expect(
    page
      .locator(".history-list")
      .getByText(/система · свёртка/)
      .first(),
  ).toBeVisible();

  await move(first, "Done");
  await move(second, "Done");
  await page.goto(`/tickets/${epic}`);
  await expect(page.getByText(/Все дети закрыты — закрыть тикет/)).toBeVisible();
  await expect(page.getByText("2 из 2")).toBeVisible();
  await expect(page.locator(".ticket-header__meta").getByText("In Progress", { exact: true })).toBeVisible();

  // ПМ закрывает эпик сам — флаг уходит.
  await page.getByLabel("Перевести в").selectOption({ label: "Done" });
  await page.getByRole("button", { name: "Перевести" }).click();
  await expect(page.locator(".ticket-header__meta").getByText("Done", { exact: true })).toBeVisible();
  await expect(page.getByText(/Все дети закрыты — закрыть тикет/)).toHaveCount(0);
});
