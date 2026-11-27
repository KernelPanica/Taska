import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { testConfig, type AppConfig } from "../src/config.js";
import { TEST_PASSWORD } from "../src/testing/accounts.js";
import { CatalogError, type Catalog, type CatalogEvent, type CatalogProfileData } from "../src/catalog/catalog.js";

export async function createTestApp(config: Partial<AppConfig> = {}, options: Omit<CreateAppOptions, "config"> = {}) {
  return createApp({ webRoot: "/nonexistent", ...options, config: testConfig(config) });
}

/** Простая «банка» cookie для прохождения редиректов входа через inject. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: LightMyRequestResponse) {
    const header = response.headers["set-cookie"];
    for (const line of Array.isArray(header) ? header : header ? [header] : []) {
      const [pair] = line.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (!pair || index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/Max-Age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string) {
    return this.cookies.get(name);
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export interface Client {
  jar: CookieJar;
  request(
    method: string,
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  form(url: string, fields: Record<string, string>): Promise<LightMyRequestResponse>;
}

export function client(app: FastifyInstance, jar = new CookieJar()): Client {
  return {
    jar,
    async request(method, url, payload, headers = {}) {
      const response = await app.inject({
        method: method as "GET",
        url,
        headers: { cookie: jar.header(), "user-agent": "vitest", ...headers },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
      jar.store(response);
      return response;
    },
    async form(url, fields) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(fields).toString(),
      });
      jar.store(response);
      return response;
    },
  };
}

/** Скрытые поля формы заглушки YourSpace. */
export function hiddenFields(html: string) {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1] as string] = (match[2] as string).replaceAll("&#38;", "&");
  }
  return fields;
}

export function location(response: LightMyRequestResponse) {
  return String(response.headers.location ?? "");
}

export interface LoginOptions {
  method?: "password" | "google";
  login?: string;
  password?: string;
  google?: string;
  otp?: string;
  returnTo?: string;
}

/**
 * Полный вход через заглушку YourSpace: /auth/login → страница YourSpace → (код) → callback.
 * Возвращает последний ответ (редирект из callback) и клиента с cookie.
 */
export async function signIn(app: FastifyInstance, options: LoginOptions = {}) {
  const user = client(app);
  const method = options.method ?? "password";
  const query = new URLSearchParams({ method, ...(options.returnTo ? { returnTo: options.returnTo } : {}) });
  let response = await user.request("GET", `/api/v1/auth/login?${query}`);
  if (response.statusCode !== 302) throw new Error(`login start failed: ${response.statusCode} ${response.body}`);
  response = await user.request("GET", location(response));

  response = await user.form(
    "/dev/yourspace/authorize",
    method === "google"
      ? { ...hiddenFields(response.body), google: options.google ?? "anna.test@gmail.test" }
      : { ...hiddenFields(response.body), login: options.login ?? "anna", password: options.password ?? TEST_PASSWORD },
  );
  // Цикл: ответы заглушки (форма кода, step-up) и редиректы обратно в YourTask.
  for (let step = 0; step < 6; step += 1) {
    if (response.statusCode === 200 && response.body.includes('name="otp"')) {
      response = await user.form("/dev/yourspace/authorize", {
        ...hiddenFields(response.body),
        otp: options.otp ?? "123456",
      });
      continue;
    }
    if (response.statusCode === 302 || response.statusCode === 303) {
      const target = location(response);
      if (!target.startsWith("/api/v1/auth/") && !target.startsWith("/dev/yourspace/")) break;
      response = await user.request("GET", target);
      continue;
    }
    break;
  }
  return { response, user };
}

export async function me(user: Client) {
  return user.request("GET", "/api/v1/me");
}

export async function csrf(user: Client) {
  return { "x-yourtask-csrf": (await me(user)).json().csrfToken as string };
}

/** Каталог YourSpace в памяти для тестов синхронизации (docs/adr/0009). */
export class FakeCatalog implements Catalog {
  readonly kind = "yourspace" as const;
  readonly people = new Map<string, CatalogProfileData>();
  readonly log: CatalogEvent[] = [];
  failing = false;

  private check() {
    if (this.failing) throw new CatalogError("YourSpace is down");
  }

  put(person: Partial<CatalogProfileData> & { id: string }, type: CatalogEvent["type"] = "updated") {
    const current = this.people.get(person.id);
    const next: CatalogProfileData = {
      username: person.id,
      displayName: person.fullName ?? person.id,
      role: "member",
      active: true,
      deactivatedAt: null,
      contactEmail: null,
      fullName: null,
      nickname: null,
      telegram: null,
      vk: null,
      city: null,
      timezone: null,
      portfolio: null,
      giteaLogin: null,
      perforceLogin: null,
      availabilityHours: null,
      roleTitle: null,
      joinedAt: null,
      membershipStatus: "active",
      tenure: { months: 20, text: "1 г 8 мес", frozen: false },
      revision: 0,
      extraEmail: null,
      phone: null,
      birthDate: null,
      comments: null,
      unavailabilityRisk: null,
      masked: [],
      ...current,
      ...person,
    };
    next.revision += 1;
    this.people.set(person.id, next);
    this.log.push({
      id: this.log.length + 1,
      userId: person.id,
      type: current ? type : "created",
      createdAt: Date.now(),
    });
    return next;
  }

  async list() {
    this.check();
    return [...this.people.values()];
  }

  async profile(id: string) {
    this.check();
    return this.people.get(id) ?? null;
  }

  async events(after: number) {
    this.check();
    const items = this.log.filter((event) => event.id > after);
    return { items, next: items.at(-1)?.id ?? after };
  }

  profileUrl(id: string) {
    return `https://id.yourspace.example/people/${id}`;
  }
}
