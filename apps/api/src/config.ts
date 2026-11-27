import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Профили конфигурации (docs/adr/0002):
 * - development — локальный запуск одной командой: всё имеет безопасные значения по умолчанию,
 *   YourSpace подменяется встроенной заглушкой, тестовые данные создаются автоматически;
 * - test — автотесты: БД в памяти, фиксированные секреты, заглушка YourSpace, тестовые данные;
 * - production — всё обязательное задаётся явно, заглушка и тестовые данные запрещены.
 */
export type Profile = "development" | "test" | "production";

export type YourSpaceConfig =
  | { mode: "dev" }
  | { mode: "oidc"; issuer: string; clientId: string; clientSecret: string; scopes: string };

export interface AppConfig {
  profile: Profile;
  databasePath: string;
  secretKey: string;
  publicUrl: string;
  secureCookies: boolean;
  logLevel: string;
  yourspace: YourSpaceConfig;
  /** Email-адреса, которые получают роль администратора при входе. */
  superadminEmails: string[];
  /** Создавать тестовое пространство и тестовых пользователей. */
  seedTestData: boolean;
  sessionTtlHours: number;
  /** Доверять X-Forwarded-* (за обратным прокси). */
  trustProxy: boolean;
  /** Как часто опрашивать ленту событий каталога YourSpace; 0 — только при запуске и вручную (docs/adr/0009). */
  catalogPollSeconds: number;
  /** Токен, с которым YourSpace читает колодцы и команды (GET /api/v1/catalog/org); пусто — выгрузка выключена. */
  catalogExportToken: string;
  /** Префикс ключей тикетов AOS-N; задаётся при установке (R-2.6). */
  ticketKeyPrefix: string;
  /** YourWiki: заглушка (разработка), API по контракту WK-02 или выключено (docs/adr/0018). */
  yourwiki: YourWikiConfig;
  /** Заголовки ссылок с адресов внутренней сети (только разработка и тесты: защита от SSRF). */
  linkPreviewPrivate: boolean;
  /** Каталог вложений — вне публичного каталога веба; выдача только через API с проверкой прав (docs/adr/0019). */
  attachmentsPath: string;
  /** Как часто системное правило проверяет корзину на просроченное, минуты; 0 — выключено (docs/adr/0020). */
  trashSweepMinutes: number;
  /**
   * Адрес YourSpace для переключателя сайтов: оттуда берётся список сайтов (GET /api/products).
   * По умолчанию — издатель OIDC, в разработке — заглушка /dev/yourspace.
   */
  yourspaceUrl: string;
  /** Адреса сайтов для dev-заглушки YourSpace — те же переменные, что в .env YourSpace (YOURSPACE_*_URL). */
  siteUrls: Record<string, string>;
}

/** Переменные адресов сайтов, как в YourSpace (docs/site-switcher.md). Пустая — сайт не подключён. */
export const SITE_URL_ENV = {
  yourdash: "YOURSPACE_YOURDASH_URL",
  yourmail: "YOURSPACE_YOURMAIL_URL",
  yourtask: "YOURSPACE_YOURTASK_URL",
  yourwiki: "YOURSPACE_YOURWIKI_URL",
} as const;

/** Полный адрес через HTTPS (http — только localhost), без логина и пароля; иначе ошибка с именем переменной. */
export function siteUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a full address like https://task.example.com`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError(`${name} must use HTTPS (http only for localhost)`);
  }
  if (url.username || url.password) throw new ConfigError(`${name} must not contain a login or password`);
  return url.href;
}

function siteUrlsFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, name] of Object.entries(SITE_URL_ENV)) {
    const value = env[name]?.trim();
    if (value) result[id] = siteUrl(value, name);
  }
  return result;
}

export type YourWikiConfig = { mode: "dev" } | { mode: "off" } | { mode: "api"; url: string };

function yourwikiFrom(env: NodeJS.ProcessEnv, profile: Profile): YourWikiConfig {
  const mode =
    env.YOURTASK_YOURWIKI_MODE ?? (profile === "production" ? (env.YOURTASK_YOURWIKI_URL ? "api" : "off") : "dev");
  if (mode === "dev" || mode === "off") return { mode };
  if (mode !== "api") throw new ConfigError(`YOURTASK_YOURWIKI_MODE must be "dev", "api" or "off", got "${mode}"`);
  const url = (env.YOURTASK_YOURWIKI_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new ConfigError("YOURTASK_YOURWIKI_URL is required in api mode");
  try {
    new URL(url);
  } catch {
    throw new ConfigError("YOURTASK_YOURWIKI_URL must be an absolute URL");
  }
  // WK-02 узнаёт человека по его токену YourSpace: отдельного сервисного токена нет.
  return { mode, url };
}

export const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export class ConfigError extends Error {
  override name = "ConfigError";
}

function profileFrom(env: NodeJS.ProcessEnv): Profile {
  const value = env.YOURTASK_PROFILE ?? env.NODE_ENV;
  if (value === "production" || value === "test") return value;
  return "development";
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

/** В разработке секрет создаётся один раз и хранится рядом с БД, чтобы сессии переживали перезапуск. */
function developmentSecret(databasePath: string): string {
  const file = join(dirname(databasePath), ".secret-key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function yourspaceFrom(env: NodeJS.ProcessEnv, profile: Profile): YourSpaceConfig {
  const mode = env.YOURTASK_YOURSPACE_MODE ?? (profile === "production" ? "oidc" : "dev");
  if (mode === "dev") return { mode: "dev" };
  if (mode !== "oidc") throw new ConfigError(`YOURTASK_YOURSPACE_MODE must be "dev" or "oidc", got "${mode}"`);
  const issuer = env.YOURTASK_YOURSPACE_ISSUER ?? "";
  const clientId = env.YOURTASK_YOURSPACE_CLIENT_ID ?? "";
  const clientSecret = env.YOURTASK_YOURSPACE_CLIENT_SECRET ?? "";
  if (!issuer || !clientId || !clientSecret) {
    throw new ConfigError(
      "YOURTASK_YOURSPACE_ISSUER, YOURTASK_YOURSPACE_CLIENT_ID and YOURTASK_YOURSPACE_CLIENT_SECRET are required in oidc mode",
    );
  }
  return {
    mode: "oidc",
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    scopes: env.YOURTASK_YOURSPACE_SCOPES ?? "openid email profile",
  };
}

function yourspaceUrlFrom(env: NodeJS.ProcessEnv, profile: Profile, publicUrl: string) {
  const explicit = env.YOURTASK_YOURSPACE_URL?.trim();
  if (explicit) return siteUrl(explicit, "YOURTASK_YOURSPACE_URL");
  const mode = env.YOURTASK_YOURSPACE_MODE ?? (profile === "production" ? "oidc" : "dev");
  if (mode === "oidc" && env.YOURTASK_YOURSPACE_ISSUER)
    return siteUrl(env.YOURTASK_YOURSPACE_ISSUER, "YOURTASK_YOURSPACE_ISSUER");
  return `${publicUrl}/dev/yourspace/`;
}

export function validateConfig(config: AppConfig): AppConfig {
  if (config.secretKey.length < 32) {
    throw new ConfigError("YOURTASK_SECRET_KEY must be a random value of at least 32 characters");
  }
  if (!config.databasePath) throw new ConfigError("YOURTASK_DATABASE_PATH must not be empty");
  try {
    new URL(config.publicUrl);
  } catch {
    throw new ConfigError("YOURTASK_PUBLIC_URL must be an absolute URL");
  }
  if (config.catalogExportToken && config.catalogExportToken.length < 32) {
    throw new ConfigError("YOURTASK_CATALOG_EXPORT_TOKEN must be a random value of at least 32 characters");
  }
  if (!Number.isFinite(config.catalogPollSeconds) || config.catalogPollSeconds < 0) {
    throw new ConfigError("YOURTASK_CATALOG_POLL_SECONDS must be 0 or a positive number of seconds");
  }
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(config.ticketKeyPrefix)) {
    throw new ConfigError("YOURTASK_KEY_PREFIX must be 1–10 Latin capitals or digits, starting with a letter");
  }
  if (config.profile === "production") {
    if (config.yourspace.mode === "dev") {
      throw new ConfigError("The development YourSpace stub cannot be used in production");
    }
    if (config.seedTestData) throw new ConfigError("Test data cannot be seeded in production");
    if (config.yourwiki.mode === "dev")
      throw new ConfigError("The development YourWiki stub cannot be used in production");
    if (config.linkPreviewPrivate)
      throw new ConfigError("Link previews from the internal network are for development only");
  }
  return config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const profile = profileFrom(env);
  const databasePath =
    env.YOURTASK_DATABASE_PATH ?? (profile === "test" ? ":memory:" : resolve(repoRoot, "data", "yourtask.db"));

  let secretKey = env.YOURTASK_SECRET_KEY ?? "";
  if (!secretKey && profile === "test") secretKey = "test-secret-key-that-is-at-least-32-characters";
  if (!secretKey && profile === "development") secretKey = developmentSecret(databasePath);
  if (!secretKey) throw new ConfigError("YOURTASK_SECRET_KEY is required in production");

  const publicUrl = (env.YOURTASK_PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  return validateConfig({
    profile,
    databasePath,
    secretKey,
    publicUrl,
    secureCookies: bool(env.YOURTASK_SECURE_COOKIES, publicUrl.startsWith("https://")),
    logLevel: env.YOURTASK_LOG_LEVEL ?? (profile === "test" ? "silent" : "info"),
    yourspace: yourspaceFrom(env, profile),
    superadminEmails: list(env.YOURTASK_SUPERADMIN_EMAILS),
    seedTestData: bool(env.YOURTASK_SEED_TEST_DATA, profile !== "production"),
    sessionTtlHours: Number.parseInt(env.YOURTASK_SESSION_TTL_HOURS ?? "168", 10) || 168,
    trustProxy: bool(env.YOURTASK_TRUST_PROXY, false),
    catalogPollSeconds: Number(env.YOURTASK_CATALOG_POLL_SECONDS ?? (profile === "test" ? "0" : "10")),
    catalogExportToken: env.YOURTASK_CATALOG_EXPORT_TOKEN ?? "",
    ticketKeyPrefix: env.YOURTASK_KEY_PREFIX ?? "AOS",
    yourwiki: yourwikiFrom(env, profile),
    linkPreviewPrivate: bool(env.YOURTASK_LINK_PREVIEW_PRIVATE, profile !== "production"),
    attachmentsPath:
      env.YOURTASK_ATTACHMENTS_PATH ??
      (databasePath === ":memory:"
        ? join(tmpdir(), `yourtask-attachments-${process.pid}`)
        : join(dirname(databasePath), "attachments")),
    trashSweepMinutes: Number(env.YOURTASK_TRASH_SWEEP_MINUTES ?? (profile === "test" ? "0" : "60")),
    yourspaceUrl: yourspaceUrlFrom(env, profile, publicUrl),
    siteUrls: siteUrlsFrom(env),
  });
}

/** Тестовая конфигурация, независимая от окружения процесса. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return validateConfig({
    profile: "test",
    databasePath: ":memory:",
    secretKey: "test-secret-key-that-is-at-least-32-characters",
    publicUrl: "http://localhost:3000",
    secureCookies: false,
    logLevel: "silent",
    yourspace: { mode: "dev" },
    superadminEmails: [],
    seedTestData: true,
    sessionTtlHours: 168,
    trustProxy: false,
    catalogPollSeconds: 0,
    catalogExportToken: "",
    ticketKeyPrefix: "AOS",
    yourwiki: { mode: "dev" },
    linkPreviewPrivate: true,
    attachmentsPath: join(tmpdir(), `yourtask-attachments-${process.pid}-${Math.random().toString(36).slice(2)}`),
    trashSweepMinutes: 0,
    yourspaceUrl: "http://localhost:3000/dev/yourspace/",
    siteUrls: {},
    ...overrides,
  });
}
