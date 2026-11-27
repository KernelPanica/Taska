import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { client, createTestApp, csrf, hiddenFields, location, me, signIn } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

describe("sign-in with a YourSpace account (R-2.1)", () => {
  test("login and password: session is created and the user is provisioned", async () => {
    app = await createTestApp();
    const { response, user } = await signIn(app, { login: "anna", returnTo: "/spaces/test" });
    expect(response.statusCode).toBe(302);
    expect(location(response)).toBe("/spaces/test");
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("yourtask_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const body = (await me(user)).json();
    expect(body.user).toMatchObject({
      email: "anna@yourspace.test",
      name: "Анна Тестова",
      role: "member",
      locale: "ru",
    });
    expect(body.session).toMatchObject({ method: "password", mfa: false });
    expect(body.csrfToken).toEqual(expect.any(String));
  });

  test("linked Google account signs in; an unlinked one does not", async () => {
    app = await createTestApp();
    const { user } = await signIn(app, { method: "google", google: "anna.test@gmail.test" });
    expect((await me(user)).json().session.method).toBe("google");

    const stranger = await signIn(app, { method: "google", google: "unlinked.person@gmail.test" });
    expect(stranger.response.statusCode).toBe(401);
    expect(stranger.response.body).toContain("не привязан");
    expect((await me(stranger.user)).statusCode).toBe(401);
  });

  test("wrong password stays on YourSpace and creates no session", async () => {
    app = await createTestApp();
    const { response, user } = await signIn(app, { login: "anna", password: "wrong" });
    expect(response.statusCode).toBe(401);
    expect(user.jar.get("yourtask_session")).toBeUndefined();
  });

  test("first sign-in of an unknown YourSpace account provisions a regular user", async () => {
    app = await createTestApp({ superadminEmails: [] });
    const { user } = await signIn(app, { login: "vera" });
    expect((await me(user)).json().user).toMatchObject({ email: "vera@yourspace.test", role: "member" });
  });

  test("administrators always pass a second check", async () => {
    app = await createTestApp();
    const { user } = await signIn(app, { login: "admin", otp: "123456" });
    expect((await me(user)).json()).toMatchObject({ user: { role: "superadmin" }, session: { mfa: true } });

    const wrong = await signIn(app, { login: "admin", otp: "000000" });
    expect(wrong.response.statusCode).toBe(401);
    expect(wrong.user.jar.get("yourtask_session")).toBeUndefined();
  });

  test("administrator without a second factor in YourSpace is refused after step-up", async () => {
    app = await createTestApp();
    const { response, user } = await signIn(app, { login: "admin-no2fa" });
    // Заглушка показывает, что вторая проверка не настроена; пользователь возвращается в YourTask.
    expect(response.statusCode).toBe(403);
    const fields = hiddenFields(response.body);
    const back = await user.request("GET", `/api/v1/auth/callback?${new URLSearchParams(fields)}`);
    expect(location(back)).toBe("/login?error=mfa_required");
    expect(user.jar.get("yourtask_session")).toBeUndefined();
  });

  test("callback rejects a forged state, a missing login cookie and a replayed code", async () => {
    app = await createTestApp();
    const anonymous = client(app);
    const forged = await anonymous.request("GET", "/api/v1/auth/callback?code=x&state=y");
    expect(location(forged)).toBe("/login?error=login_expired");

    // Перехватываем код до callback и пытаемся использовать дважды.
    const user = client(app);
    let response = await user.request("GET", "/api/v1/auth/login");
    response = await user.request("GET", location(response));
    response = await user.form("/dev/yourspace/authorize", {
      ...hiddenFields(response.body),
      login: "anna",
      password: "yourspace",
    });
    const callback = location(response);
    const flowCookie = user.jar.get("yourtask_login") as string;
    expect((await user.request("GET", callback)).headers.location).toBe("/");
    const replay = await app.inject({ url: callback, headers: { cookie: `yourtask_login=${flowCookie}` } });
    expect(location(replay)).toBe("/login?error=login_expired");
  });

  test("returnTo cannot redirect outside the application", async () => {
    app = await createTestApp();
    for (const returnTo of ["//evil.test", "/api/v1/me", "https://evil.test"]) {
      const { response } = await signIn(app, { returnTo });
      expect(location(response), returnTo).toBe("/");
    }
  });

  test("profile language is stored", async () => {
    app = await createTestApp();
    const { user } = await signIn(app);
    const response = await user.request("PATCH", "/api/v1/me", { locale: "en" }, await csrf(user));
    expect(response.statusCode).toBe(200);
    expect(response.json().user.locale).toBe("en");
    expect((await me(user)).json().user.locale).toBe("en");
    const invalid = await user.request("PATCH", "/api/v1/me", { locale: "de" }, await csrf(user));
    expect(invalid.json().code).toBe("validation_failed");
  });
});
