import type { Locale, UserRole } from "@yourtask/contracts";

/**
 * Тестовые аккаунты (docs/adr/0006). Используются в двух местах:
 * - заглушка YourSpace (вход и каталог) знает их логины, пароли, привязанный Google, код второй проверки
 *   и чувствительные поля профиля;
 * - сид создаёт из них тестовых пользователей YourTask (кроме `seeded: false`).
 * Пароли и чувствительные поля живут только на «стороне YourSpace» — в базе YourTask их нет.
 */
export interface TestAccount {
  subject: string;
  login: string;
  email: string;
  name: string;
  locale: Locale;
  /** Привязанный Google-аккаунт или null. */
  google: string | null;
  /** Код второй проверки в заглушке или null, если вторая проверка не настроена. */
  otp: string | null;
  role: UserRole;
  /** false — аккаунт есть в YourSpace, но не тестовый пользователь YourTask (проверка изоляции). */
  seeded: boolean;
  telegram: string | null;
  /** Чувствительные поля (R-2.2): в YourTask приходят только маской. */
  phone: string | null;
  birthDate: string | null;
}

export const TEST_PASSWORD = "yourspace";
export const TEST_OTP = "123456";
export const TEST_SPACE = { slug: "test", name: "Тестовое пространство" } as const;

export const testAccounts: readonly TestAccount[] = [
  {
    subject: "ys-test-anna",
    login: "anna",
    email: "anna@yourspace.test",
    name: "Анна Тестова",
    locale: "ru",
    google: "anna.test@gmail.test",
    otp: null,
    role: "member",
    seeded: true,
    telegram: "@anna_test",
    phone: "+7 900 000-11-22",
    birthDate: "1995-04-12",
  },
  {
    subject: "ys-test-ben",
    login: "ben",
    email: "ben@yourspace.test",
    name: "Ben Tester",
    locale: "en",
    google: null,
    otp: null,
    role: "member",
    seeded: true,
    telegram: "@ben_tester",
    phone: null,
    birthDate: null,
  },
  {
    subject: "ys-test-admin",
    login: "admin",
    email: "admin@yourspace.test",
    name: "Суперадмин Тестовый",
    locale: "ru",
    google: "admin.test@gmail.test",
    otp: TEST_OTP,
    role: "superadmin",
    seeded: true,
    telegram: "@ys_admin",
    phone: "+7 900 000-33-44",
    birthDate: null,
  },
  {
    subject: "ys-test-admin-no2fa",
    login: "admin-no2fa",
    email: "admin-no2fa@yourspace.test",
    name: "Суперадмин без второй проверки",
    locale: "ru",
    google: null,
    otp: null,
    role: "superadmin",
    seeded: true,
    telegram: null,
    phone: null,
    birthDate: null,
  },
  {
    subject: "ys-dev-vera",
    login: "vera",
    email: "vera@yourspace.test",
    name: "Вера Обычная",
    locale: "ru",
    google: null,
    otp: null,
    role: "member",
    seeded: false,
    telegram: "@vera_o",
    phone: null,
    birthDate: "1999-09-09",
  },
];

/** Люди, у которых есть аккаунт в каталоге заглушки YourSpace, но нет тестового входа с привязкой. */
const catalogPerson = (login: string, name: string, telegram: string | null = null): TestAccount => ({
  subject: `ys-test-${login}`,
  login,
  email: `${login}@yourspace.test`,
  name,
  locale: "ru",
  google: null,
  otp: null,
  role: "member",
  seeded: false,
  telegram,
  phone: null,
  birthDate: null,
});

export const testCatalogPeople: readonly TestAccount[] = [
  catalogPerson("olga", "Ольга Пиксель", "@olga_px"),
  catalogPerson("igor", "Игорь Сервер"),
  catalogPerson("maria", "Мария Тест"),
  catalogPerson("dmitry", "Дмитрий Звук"),
  catalogPerson("nina", "Нина Аналитик"),
  catalogPerson("pavel", "Павел Аниматор"),
  catalogPerson("petr", "Пётр Старожилов"),
];

/**
 * Люди, заведённые в YourTask вручную до подключения каталога (YT-02). При первой синхронизации
 * сопоставляются с каталогом по почте; Пётр заведён с другой почтой — остаётся неразобранной строкой
 * отчёта сопоставления, пока суперадмин не свяжет его вручную (docs/adr/0009).
 */
export const testPeople = [
  { email: "olga@yourspace.test", name: "Ольга Пиксель" },
  { email: "igor@yourspace.test", name: "Игорь Сервер" },
  { email: "maria@yourspace.test", name: "Мария Тест" },
  { email: "dmitry@yourspace.test", name: "Дмитрий Звук" },
  { email: "nina@yourspace.test", name: "Нина Аналитик" },
  { email: "pavel@yourspace.test", name: "Павел Аниматор" },
  { email: "petr.old@yourspace.test", name: "Пётр Старожил" },
] as const;

/**
 * Тестовая структура (критерии приёмки YT-02): три фичекоманды с ПМами, шесть колодцев с лидами;
 * Анна — в двух командах и ни в одном колодце. Сценарии YT-08 (Жабы, Хрюшки, ГД) тесты заводят сами.
 */
export const testStructure = {
  teams: [
    {
      name: "Совы",
      pm: "admin@yourspace.test",
      members: ["anna@yourspace.test", "olga@yourspace.test", "igor@yourspace.test"],
    },
    {
      name: "Ежи",
      pm: "nina@yourspace.test",
      members: ["anna@yourspace.test", "maria@yourspace.test", "dmitry@yourspace.test"],
    },
    { name: "Лисы", pm: "ben@yourspace.test", members: ["pavel@yourspace.test", "ben@yourspace.test"] },
  ],
  guilds: [
    { name: "Арт", lead: "olga@yourspace.test", members: ["olga@yourspace.test"] },
    { name: "Анимация", lead: "pavel@yourspace.test", members: ["pavel@yourspace.test"] },
    { name: "Программирование", lead: "igor@yourspace.test", members: ["igor@yourspace.test", "ben@yourspace.test"] },
    { name: "Тестирование", lead: "maria@yourspace.test", members: ["maria@yourspace.test"] },
    { name: "Звук", lead: "dmitry@yourspace.test", members: ["dmitry@yourspace.test"] },
    { name: "Аналитика", lead: "nina@yourspace.test", members: ["nina@yourspace.test"] },
  ],
} as const;
