import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { OidcYourSpace } from "../src/auth/oidc-provider.js";
import { client, createTestApp, FakeCatalog, location, me } from "./helpers.js";

const issuer = "https://id.yourspace.example";

const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "ys-key-1";

/** id_token, подписанный ключом YourSpace (RS256), или чужим ключом — для проверки подписи. */
function jwt(claims: Record<string, unknown>, key = signing.privateKey) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid: KID, typ: "JWT" })}.${encode(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

/** Поддельный YourSpace: discovery, JWKS и token endpoint; claims задаёт тест. */
function fakeYourSpace(claimsFor: (nonce: string) => Record<string, unknown>, key = signing.privateKey) {
  const requests: { url: string; body?: string }[] = [];
  let lastNonce = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/oauth/jwks`,
      });
    }
    if (url === `${issuer}/oauth/jwks`) {
      return Response.json({
        keys: [{ ...signing.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }],
      });
    }
    if (url === `${issuer}/token`) return Response.json({ id_token: jwt(claimsFor(lastNonce), key) });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    requests,
    fetchImpl,
    rememberNonce(authorizeUrl: string) {
      lastNonce = new URL(authorizeUrl).searchParams.get("nonce") ?? "";
    },
  };
}

const config = {
  mode: "oidc" as const,
  issuer,
  clientId: "yourtask",
  clientSecret: "secret",
  scopes: "openid email profile",
};
let app: FastifyInstance;
afterEach(async () => app?.close());

describe("OIDC adapter for YourSpace", () => {
  test("code flow with PKCE maps claims to a YourTask session", async () => {
    const fake = fakeYourSpace((nonce) => ({
      iss: issuer,
      aud: "yourtask",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce,
      sub: "ys-real-1",
      email: "Real@Example.com",
      name: "Real Person",
      amr: ["pwd"],
    }));
    app = await createTestApp(
      { publicUrl: "https://task.example" },
      { provider: new OidcYourSpace(config, fake.fetchImpl) },
    );
    const user = client(app);
    const start = await user.request("GET", "/api/v1/auth/login?method=google");
    const authorize = new URL(location(start));
    expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://task.example/api/v1/auth/callback");
    expect(authorize.searchParams.get("yourspace_method")).toBe("google");
    fake.rememberNonce(location(start));

    const state = authorize.searchParams.get("state") as string;
    const done = await user.request("GET", `/api/v1/auth/callback?code=abc&state=${state}`);
    expect(location(done)).toBe("/");
    expect(fake.requests.find((request) => request.url === `${issuer}/token`)?.body).toContain("code_verifier=");
    expect((await me(user)).json().user).toMatchObject({
      email: "real@example.com",
      name: "Real Person",
      role: "member",
    });
  });

  test("first verified YourSpace sign-in registers once even if the directory is unavailable", async () => {
    const fake = fakeYourSpace((nonce) => ({
      iss: issuer,
      aud: "yourtask",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce,
      sub: "ys-new-member",
      email: "new@example.com",
      name: "New Member",
      locale: "en",
      yourspace_role: "member",
      amr: ["pwd"],
    }));
    const catalog = new FakeCatalog();
    catalog.failing = true;
    app = await createTestApp(
      {
        profile: "production",
        publicUrl: "https://task.example",
        seedTestData: false,
        yourspace: config,
        yourwiki: { mode: "off" },
        linkPreviewPrivate: false,
      },
      { provider: new OidcYourSpace(config, fake.fetchImpl), catalog },
    );
    const count = () =>
      (
        app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE yourspace_subject = ?").get("ys-new-member") as {
          n: number;
        }
      ).n;
    expect(count()).toBe(0);
    let registeredId: string | undefined;
    for (const code of ["first", "returning"]) {
      const user = client(app);
      const start = await user.request("GET", "/api/v1/auth/login?returnTo=%2Fboards");
      fake.rememberNonce(location(start));
      const done = await user.request(
        "GET",
        `/api/v1/auth/callback?code=${code}&state=${new URL(location(start)).searchParams.get("state")}`,
      );
      expect(location(done)).toBe("/boards");
      const current = (await me(user)).json();
      expect(current.user).toMatchObject({
        name: "New Member",
        email: "new@example.com",
        role: "member",
        locale: "en",
      });
      registeredId ??= current.user.id;
      expect(current.user.id).toBe(registeredId);
      expect(count()).toBe(1);
    }
    // No embedded password/Google provider or registration endpoint in the live product.
    for (const path of ["/dev/yourspace/authorize", "/dev/yourspace/people"]) {
      expect((await app.inject({ url: path })).statusCode).toBe(404);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/register",
          payload: { email: "stranger@example.com", password: "password" },
        })
      ).statusCode,
    ).toBe(404);
  });

  test("an administrator without mfa is sent back for step-up, then refused", async () => {
    const fake = fakeYourSpace((nonce) => ({
      iss: issuer,
      aud: ["yourtask"],
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce,
      sub: "ys-real-admin",
      email: "boss@example.com",
      amr: ["pwd"],
    }));
    const catalog = new FakeCatalog();
    catalog.put({ id: "ys-real-admin", fullName: "Boss", contactEmail: "boss@example.com" });
    app = await createTestApp(
      { superadminEmails: ["boss@example.com"] },
      { provider: new OidcYourSpace(config, fake.fetchImpl), catalog },
    );
    const user = client(app);
    let response = await user.request("GET", "/api/v1/auth/login");
    fake.rememberNonce(location(response));
    response = await user.request(
      "GET",
      `/api/v1/auth/callback?code=a&state=${new URL(location(response)).searchParams.get("state")}`,
    );
    const stepUp = new URL(location(response));
    expect(stepUp.searchParams.get("acr_values")).toBe("mfa");
    fake.rememberNonce(stepUp.toString());
    response = await user.request("GET", `/api/v1/auth/callback?code=b&state=${stepUp.searchParams.get("state")}`);
    expect(location(response)).toBe("/login?error=mfa_required");
  });

  test("a token for another audience or nonce is rejected", async () => {
    const fake = fakeYourSpace(() => ({
      iss: issuer,
      aud: "someone-else",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: "wrong",
      sub: "x",
      email: "x@example.com",
    }));
    app = await createTestApp({}, { provider: new OidcYourSpace(config, fake.fetchImpl) });
    const user = client(app);
    const start = await user.request("GET", "/api/v1/auth/login");
    const done = await user.request(
      "GET",
      `/api/v1/auth/callback?code=a&state=${new URL(location(start)).searchParams.get("state")}`,
    );
    expect(location(done)).toBe("/login?error=login_failed");
  });

  test("a token signed with a foreign key is rejected", async () => {
    const fake = fakeYourSpace(
      (nonce) => ({
        iss: issuer,
        aud: "yourtask",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce,
        sub: "ys-forged",
        email: "forged@example.com",
        yourspace_role: "superadmin",
        amr: ["pwd", "otp", "mfa"],
        acr: "mfa",
      }),
      stranger.privateKey,
    );
    app = await createTestApp({}, { provider: new OidcYourSpace(config, fake.fetchImpl) });
    const user = client(app);
    const start = await user.request("GET", "/api/v1/auth/login");
    fake.rememberNonce(location(start));
    const done = await user.request(
      "GET",
      `/api/v1/auth/callback?code=a&state=${new URL(location(start)).searchParams.get("state")}`,
    );
    expect(location(done)).toBe("/login?error=login_failed");
    expect(app.db.prepare("SELECT id FROM users WHERE yourspace_subject = ?").get("ys-forged")).toBeUndefined();
  });

  test("yourspace_role=superadmin with a second factor gives the superadmin role", async () => {
    const fake = fakeYourSpace((nonce) => ({
      iss: issuer,
      aud: "yourtask",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce,
      sub: "ys-real-boss",
      email: "chief@example.com",
      name: "Chief",
      yourspace_role: "superadmin",
      amr: ["pwd", "otp", "mfa"],
      acr: "mfa",
    }));
    app = await createTestApp({}, { provider: new OidcYourSpace(config, fake.fetchImpl) });
    const user = client(app);
    const start = await user.request("GET", "/api/v1/auth/login");
    fake.rememberNonce(location(start));
    const done = await user.request(
      "GET",
      `/api/v1/auth/callback?code=a&state=${new URL(location(start)).searchParams.get("state")}`,
    );
    expect(location(done)).toBe("/");
    const current = (await me(user)).json();
    expect(current.user.role).toBe("superadmin");
    expect(current.session).toMatchObject({ method: "password", mfa: true });
  });

  test("YourSpace being down is reported as identity_provider_error", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    app = await createTestApp({}, { provider: new OidcYourSpace(config, failing) });
    const response = await client(app).request("GET", "/api/v1/auth/login");
    expect(location(response)).toBe("/login?error=identity_provider_error");
  });
});
