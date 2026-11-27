import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { LoginMethod } from "@yourtask/contracts";
import { TEST_PASSWORD } from "../testing/accounts.js";
import { DevCatalogError, type DevAccount, type DevCatalog } from "../catalog/dev-catalog.js";
import {
  IdentityProviderError,
  type AuthorizationRequest,
  type CodeExchange,
  type Identity,
  type IdentityProvider,
} from "./provider.js";

/**
 * Заглушка YourSpace для разработки и автотестов. Включается только в профилях
 * development/test (production её запрещает, см. config.ts).
 *
 * Ведёт себя как OIDC-провайдер: страница входа по логину/паролю или «через Google»,
 * вторая проверка кодом, одноразовый код авторизации с PKCE, короткая SSO-сессия
 * для повторной проверки (step-up) без повторного ввода пароля.
 */
export const DEV_YOURSPACE_PATH = "/dev/yourspace";
const SSO_COOKIE = "ys_dev_sso";
const CODE_TTL_MS = 60_000;
const SSO_TTL_MS = 10 * 60_000;

interface IssuedCode {
  identity: Identity;
  codeChallenge: string;
  redirectUri: string;
  nonce: string;
  expiresAt: number;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export class DevYourSpace implements IdentityProvider {
  readonly kind = "dev" as const;
  private readonly codes = new Map<string, IssuedCode>();
  /** Выданные токены доступа: как userinfo YourSpace, им заглушка YourWiki узнаёт человека (WK-02). */
  private readonly tokens = new Map<string, { subject: string; expiresAt: number }>();

  /** sub по токену доступа или null — аналог `/oauth/userinfo` YourSpace. */
  userinfo(token: string) {
    const found = this.tokens.get(token);
    return found && found.expiresAt > Date.now() ? found.subject : null;
  }
  private readonly ssoKey = randomBytes(32);

  /** Аккаунты берутся из каталога заглушки: деактивированный человек войти не может. */
  constructor(readonly catalog: DevCatalog) {}

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const params = new URLSearchParams({
      client_id: "yourtask",
      response_type: "code",
      redirect_uri: request.redirectUri,
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      login_method: request.method,
    });
    if (request.requireMfa) params.set("require_mfa", "1");
    return `${DEV_YOURSPACE_PATH}/authorize?${params}`;
  }

  async exchange({ code, codeVerifier, redirectUri, nonce }: CodeExchange): Promise<Identity> {
    const key = hash(code);
    const issued = this.codes.get(key);
    this.codes.delete(key);
    if (!issued || issued.expiresAt < Date.now()) {
      throw new IdentityProviderError("Authorization code is invalid or expired", true);
    }
    if (
      !safeEqual(hash(codeVerifier), issued.codeChallenge) ||
      issued.redirectUri !== redirectUri ||
      !safeEqual(issued.nonce, nonce)
    ) {
      throw new IdentityProviderError("Authorization code does not match this sign-in", true);
    }
    const accessToken = randomBytes(32).toString("base64url");
    const accessTokenExpiresAt = Date.now() + 12 * 3_600_000;
    this.tokens.set(accessToken, { subject: issued.identity.subject, expiresAt: accessTokenExpiresAt });
    return { ...issued.identity, accessToken, accessTokenExpiresAt };
  }

  findByLogin(login: string) {
    return this.catalog.findByLogin(login);
  }

  findByGoogle(google: string) {
    return this.catalog.findByGoogle(google);
  }

  findBySubject(subject: string) {
    const account = this.catalog.account(subject);
    return account?.active ? account : undefined;
  }

  linkedGoogleAccounts() {
    return this.catalog.linkedGoogleAccounts();
  }

  issueCode(account: DevAccount, method: LoginMethod, mfa: boolean, params: AuthorizeParams): string {
    const code = randomBytes(24).toString("base64url");
    this.codes.set(hash(code), {
      identity: {
        subject: account.id,
        email: account.email ?? `${account.login}@users.yourspace.test`,
        name: account.fullName,
        locale: account.locale,
        method,
        mfa,
        role: account.role,
      },
      codeChallenge: params.code_challenge,
      redirectUri: params.redirect_uri,
      nonce: params.nonce,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    return code;
  }

  ssoCookie(subject: string, method: LoginMethod) {
    const expires = Date.now() + SSO_TTL_MS;
    const payload = `${subject}|${method}|${expires}`;
    const signature = createHmac("sha256", this.ssoKey).update(payload).digest("base64url");
    return `${Buffer.from(payload).toString("base64url")}.${signature}`;
  }

  readSso(cookie: string | undefined): { account: DevAccount; method: LoginMethod } | null {
    if (!cookie) return null;
    const [encoded, signature] = cookie.split(".");
    if (!encoded || !signature) return null;
    const payload = Buffer.from(encoded, "base64url").toString();
    const expected = createHmac("sha256", this.ssoKey).update(payload).digest("base64url");
    if (!safeEqual(signature, expected)) return null;
    const [subject, method, expires] = payload.split("|");
    if (!subject || (method !== "password" && method !== "google") || Number(expires) < Date.now()) return null;
    const account = this.findBySubject(subject);
    return account ? { account, method } : null;
  }
}

interface AuthorizeParams {
  redirect_uri: string;
  state: string;
  nonce: string;
  code_challenge: string;
  code_challenge_method: string;
  login_method: string;
  require_mfa?: string;
}

const PARAM_KEYS = [
  "redirect_uri",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
  "login_method",
  "require_mfa",
] as const;

function readParams(source: Record<string, unknown>): AuthorizeParams | null {
  const value = (key: string) => (typeof source[key] === "string" ? (source[key] as string) : "");
  const params = {
    redirect_uri: value("redirect_uri"),
    state: value("state"),
    nonce: value("nonce"),
    code_challenge: value("code_challenge"),
    code_challenge_method: value("code_challenge_method"),
    login_method: value("login_method") || "password",
    require_mfa: value("require_mfa"),
  };
  const relativeCallback = params.redirect_uri.startsWith("/") && !params.redirect_uri.startsWith("//");
  if (
    !relativeCallback ||
    !params.state ||
    !params.nonce ||
    !params.code_challenge ||
    params.code_challenge_method !== "S256"
  ) {
    return null;
  }
  return params;
}

function cookieValue(header: string | undefined, name: string) {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function hidden(params: AuthorizeParams) {
  return PARAM_KEYS.map((key) =>
    params[key] ? `<input type="hidden" name="${key}" value="${escapeHtml(params[key] ?? "")}">` : "",
  ).join("");
}

function page(title: string, body: string, wide = false) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · YourSpace (dev)</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8ecf5}
main{width:min(380px,calc(100vw - 32px));}main.wide{width:min(760px,calc(100vw - 32px));}main{background:#141b2e;border:1px solid #26304a;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{color:#a7b0c4;font-size:14px;margin:0 0 18px}
label{display:block;font-size:13px;margin:12px 0 4px}
input[type=text],input[type=password],input[type=email],input[type=date]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #33405f;background:#0b1020;color:inherit;font-size:15px}
button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
button.secondary{background:#26304a}
.error{background:#4c1d1d;color:#fecaca;padding:10px;border-radius:8px;font-size:14px;margin-bottom:8px}
.badge{display:inline-block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#fbbf24;margin-bottom:12px}
code{background:#0b1020;padding:2px 6px;border-radius:4px}
table{width:100%;border-collapse:collapse;font-size:14px;margin:12px 0}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid #26304a}
a{color:#93c5fd}.muted{color:#a7b0c4}.row{display:flex;gap:8px;flex-wrap:wrap}.row button{width:auto;padding:9px 14px}
</style></head><body><main${wide ? ' class="wide"' : ""}><span class="badge">YourSpace · заглушка для разработки</span>${body}</main></body></html>`;
}

function passwordForm(params: AuthorizeParams, error?: string) {
  return page(
    "Вход",
    `<h1>Вход в YourSpace</h1><p>Sign in with your YourSpace account</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="${DEV_YOURSPACE_PATH}/authorize">${hidden(params)}
<input type="hidden" name="step" value="password">
<label for="login">Логин / Login</label><input id="login" name="login" type="text" autocomplete="username" required autofocus>
<label for="password">Пароль / Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Войти / Sign in</button></form>
<p style="margin-top:16px">Тестовые логины: <code>anna</code>, <code>ben</code>, <code>admin</code>, <code>vera</code>; пароль <code>${TEST_PASSWORD}</code>.</p>`,
  );
}

function googleChooser(provider: DevYourSpace, params: AuthorizeParams, error?: string) {
  const buttons = provider
    .linkedGoogleAccounts()
    .map(
      (account) =>
        `<button class="secondary" type="submit" name="google" value="${escapeHtml(account.google ?? "")}">${escapeHtml(account.google ?? "")}</button>`,
    )
    .join("");
  return page(
    "Google",
    `<h1>Выберите аккаунт Google</h1><p>Choose a Google account linked to YourSpace</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="${DEV_YOURSPACE_PATH}/authorize">${hidden(params)}
<input type="hidden" name="step" value="google">${buttons}
<button class="secondary" type="submit" name="google" value="unlinked.person@gmail.test">unlinked.person@gmail.test (не привязан)</button></form>`,
  );
}

function otpForm(params: AuthorizeParams, account: DevAccount, error?: string) {
  return page(
    "Вторая проверка",
    `<h1>Вторая проверка входа</h1><p>${escapeHtml(account.fullName)}: введите код из приложения-аутентификатора.</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="${DEV_YOURSPACE_PATH}/authorize">${hidden(params)}
<input type="hidden" name="step" value="otp">
<label for="otp">Код / Code</label><input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" required autofocus>
<button type="submit">Подтвердить / Verify</button></form>
<p style="margin-top:16px">Код в заглушке: <code>${escapeHtml(account.otp ?? "")}</code></p>`,
  );
}

export const devYourSpaceRoutes: FastifyPluginAsync<{ provider: DevYourSpace }> = async (app, { provider }) => {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  function html(reply: FastifyReply, body: string, status = 200) {
    return reply
      .code(status)
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
      .type("text/html; charset=utf-8")
      .send(body);
  }

  function complete(
    reply: FastifyReply,
    params: AuthorizeParams,
    account: DevAccount,
    method: LoginMethod,
    mfa: boolean,
  ) {
    const code = provider.issueCode(account, method, mfa, params);
    const target = new URL(params.redirect_uri, "http://placeholder");
    target.searchParams.set("code", code);
    target.searchParams.set("state", params.state);
    return reply.header("Set-Cookie", ssoHeader(account, method)).redirect(`${target.pathname}${target.search}`, 303);
  }

  function ssoHeader(account: DevAccount, method: LoginMethod) {
    return `${SSO_COOKIE}=${provider.ssoCookie(account.id, method)}; Path=${DEV_YOURSPACE_PATH}; HttpOnly; SameSite=Lax; Max-Age=600`;
  }

  /** После первичной проверки: при настроенной второй проверке — всегда спрашиваем код. */
  function afterPrimary(reply: FastifyReply, params: AuthorizeParams, account: DevAccount, method: LoginMethod) {
    if (account.otp) {
      reply.header("Set-Cookie", ssoHeader(account, method));
      return html(reply, otpForm(params, account));
    }
    if (params.require_mfa === "1") {
      return html(
        reply,
        page(
          "Вторая проверка",
          `<h1>Вторая проверка не настроена</h1><p>Для этого входа нужна вторая проверка, но у аккаунта ${escapeHtml(account.login)} она не включена в YourSpace.</p>
<form method="get" action="${escapeHtml(params.redirect_uri)}"><input type="hidden" name="state" value="${escapeHtml(params.state)}"><input type="hidden" name="error" value="mfa_unavailable"><button type="submit">Вернуться в YourTask</button></form>`,
        ),
        403,
      );
    }
    return complete(reply, params, account, method, false);
  }

  app.get(`${DEV_YOURSPACE_PATH}/authorize`, { schema: { hide: true } }, async (request, reply) => {
    const params = readParams(request.query as Record<string, unknown>);
    if (!params) return html(reply, page("Ошибка", "<h1>Некорректный запрос входа</h1>"), 400);

    const sso = provider.readSso(cookieValue(request.headers.cookie, SSO_COOKIE));
    if (params.require_mfa === "1" && sso) return afterPrimary(reply, params, sso.account, sso.method);
    return html(reply, params.login_method === "google" ? googleChooser(provider, params) : passwordForm(params));
  });

  app.post(`${DEV_YOURSPACE_PATH}/authorize`, { schema: { hide: true } }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const params = readParams(body);
    if (!params) return html(reply, page("Ошибка", "<h1>Некорректный запрос входа</h1>"), 400);

    if (body.step === "password") {
      const account = provider.findByLogin(body.login ?? "");
      if (!account || !safeEqual(body.password ?? "", TEST_PASSWORD)) {
        return html(reply, passwordForm(params, "Неверный логин или пароль / Wrong login or password"), 401);
      }
      return afterPrimary(reply, params, account, "password");
    }

    if (body.step === "google") {
      const account = provider.findByGoogle(body.google ?? "");
      if (!account) {
        return html(reply, googleChooser(provider, params, "Этот Google-аккаунт не привязан к YourSpace"), 401);
      }
      return afterPrimary(reply, params, account, "google");
    }

    if (body.step === "otp") {
      const sso = provider.readSso(cookieValue(request.headers.cookie, SSO_COOKIE));
      if (!sso?.account.otp) return html(reply, passwordForm(params, "Сессия входа истекла"), 401);
      if (!safeEqual((body.otp ?? "").trim(), sso.account.otp)) {
        return html(reply, otpForm(params, sso.account, "Неверный код / Wrong code"), 401);
      }
      return complete(reply, params, sso.account, sso.method, true);
    }

    return html(reply, page("Ошибка", "<h1>Неизвестный шаг входа</h1>"), 400);
  });

  // ---- каталог людей заглушки (аналог раздела «Люди» в YourSpace) ----------------------------
  // Только для разработки и автотестов: здесь «админ YourSpace» заводит, правит и деактивирует людей.
  const catalog = provider.catalog;
  const PEOPLE = `${DEV_YOURSPACE_PATH}/people`;

  function peoplePage(error?: string) {
    const rows = catalog
      .accounts()
      .map(
        (account) =>
          `<tr><td><a href="${PEOPLE}/${encodeURIComponent(account.id)}">${escapeHtml(account.fullName)}</a></td><td>${escapeHtml(account.login)}</td><td>${escapeHtml(account.telegram ?? "—")}</td><td>${account.active ? "активен" : "<strong>деактивирован</strong>"}</td></tr>`,
      )
      .join("");
    return page(
      "Люди",
      `<h1>Каталог людей YourSpace</h1><p>Заглушка для разработки. В настоящем YourSpace это раздел «Люди»; YourTask забирает отсюда людей синхронизацией.</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<table><thead><tr><th>ФИО</th><th>Логин</th><th>Telegram</th><th>Статус</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Завести человека</h2>
<form method="post" action="${PEOPLE}">
<label for="fullName">ФИО</label><input id="fullName" name="fullName" type="text" required>
<label for="login">Логин YourSpace</label><input id="login" name="login" type="text" required>
<label for="email">Почта</label><input id="email" name="email" type="email">
<label for="telegram">Telegram</label><input id="telegram" name="telegram" type="text">
<label for="phone">Телефон</label><input id="phone" name="phone" type="text">
<label for="birthDate">Дата рождения</label><input id="birthDate" name="birthDate" type="date">
<button type="submit">Завести</button></form>
<p class="muted" style="margin-top:16px">Пароль у всех людей заглушки: <code>${TEST_PASSWORD}</code>.</p>`,
      true,
    );
  }

  function profilePage(account: DevAccount, error?: string) {
    const value = (text: string | null) => escapeHtml(text ?? "");
    return page(
      account.fullName,
      `<p><a href="${PEOPLE}">← Люди</a></p><h1>${escapeHtml(account.fullName)}</h1>
<p>${escapeHtml(account.login)} · ${account.active ? "активен" : "<strong>деактивирован</strong>"}</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="${PEOPLE}/${encodeURIComponent(account.id)}">
<input type="hidden" name="step" value="update">
<label for="fullName">ФИО</label><input id="fullName" name="fullName" type="text" value="${value(account.fullName)}" required>
<label for="email">Почта</label><input id="email" name="email" type="email" value="${value(account.email)}">
<label for="telegram">Telegram</label><input id="telegram" name="telegram" type="text" value="${value(account.telegram)}">
<label for="phone">Телефон</label><input id="phone" name="phone" type="text" value="${value(account.phone)}">
<label for="birthDate">Дата рождения</label><input id="birthDate" name="birthDate" type="date" value="${value(account.birthDate)}">
<button type="submit">Сохранить</button></form>
<form method="post" action="${PEOPLE}/${encodeURIComponent(account.id)}">
<input type="hidden" name="step" value="${account.active ? "deactivate" : "reactivate"}">
<button class="secondary" type="submit">${account.active ? "Деактивировать" : "Восстановить"}</button></form>`,
      true,
    );
  }

  app.get(PEOPLE, { schema: { hide: true } }, async (_request, reply) => html(reply, peoplePage()));

  app.post(PEOPLE, { schema: { hide: true } }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    try {
      const account = catalog.create({
        login: body.login ?? "",
        fullName: body.fullName ?? "",
        email: body.email ?? null,
        telegram: body.telegram ?? null,
        phone: body.phone ?? null,
        birthDate: body.birthDate ?? null,
      });
      return reply.redirect(`${PEOPLE}/${encodeURIComponent(account.id)}`, 303);
    } catch (error) {
      if (error instanceof DevCatalogError) return html(reply, peoplePage(error.message), 400);
      throw error;
    }
  });

  app.get(`${PEOPLE}/:id`, { schema: { hide: true } }, async (request, reply) => {
    const account = catalog.account((request.params as { id: string }).id);
    if (!account) return html(reply, page("Нет такого человека", "<h1>Нет такого человека</h1>"), 404);
    return html(reply, profilePage(account));
  });

  app.post(`${PEOPLE}/:id`, { schema: { hide: true } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const account = catalog.account(id);
    if (!account) return html(reply, page("Нет такого человека", "<h1>Нет такого человека</h1>"), 404);
    if (body.step === "deactivate" || body.step === "reactivate") catalog.setActive(id, body.step === "reactivate");
    else
      catalog.update(id, {
        fullName: body.fullName ?? account.fullName,
        email: body.email ?? null,
        telegram: body.telegram ?? null,
        phone: body.phone ?? null,
        birthDate: body.birthDate ?? null,
      });
    return reply.redirect(`${PEOPLE}/${encodeURIComponent(id)}`, 303);
  });
};
