import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, csrf, me, signIn } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

describe("sessions can be revoked", () => {
  test("a user lists sessions and revokes another device", async () => {
    app = await createTestApp();
    const laptop = (await signIn(app)).user;
    const phone = (await signIn(app)).user;

    const list = (await laptop.request("GET", "/api/v1/me/sessions")).json().items;
    expect(list).toHaveLength(2);
    expect(list.filter((item: { current: boolean }) => item.current)).toHaveLength(1);
    const phoneSessionId = (await me(phone)).json().session.id;

    const revoked = await laptop.request(
      "DELETE",
      `/api/v1/me/sessions/${phoneSessionId}`,
      undefined,
      await csrf(laptop),
    );
    expect(revoked.statusCode).toBe(204);
    expect((await me(phone)).statusCode).toBe(401);
    expect((await me(laptop)).statusCode).toBe(200);
    expect((await laptop.request("GET", "/api/v1/me/sessions")).json().items).toHaveLength(1);
  });

  test("revoke-others keeps only the current session; logout ends it", async () => {
    app = await createTestApp();
    const first = (await signIn(app)).user;
    const second = (await signIn(app)).user;
    const third = (await signIn(app)).user;
    const result = await first.request("POST", "/api/v1/me/sessions/revoke-others", undefined, await csrf(first));
    expect(result.json()).toEqual({ revoked: 2 });
    expect((await me(second)).statusCode).toBe(401);
    expect((await me(third)).statusCode).toBe(401);

    const logout = await first.request("POST", "/api/v1/auth/logout", undefined, await csrf(first));
    expect(logout.statusCode).toBe(204);
    expect((await me(first)).statusCode).toBe(401);
  });

  test("a user cannot revoke someone else's session", async () => {
    app = await createTestApp();
    const anna = (await signIn(app, { login: "anna" })).user;
    const ben = (await signIn(app, { login: "ben" })).user;
    const benSession = (await me(ben)).json().session.id;
    const response = await anna.request("DELETE", `/api/v1/me/sessions/${benSession}`, undefined, await csrf(anna));
    expect(response.json().code).toBe("not_found");
    expect((await me(ben)).statusCode).toBe(200);
  });

  test("an administrator revokes all sessions of a user; members cannot", async () => {
    app = await createTestApp();
    const admin = (await signIn(app, { login: "admin" })).user;
    const anna = (await signIn(app, { login: "anna" })).user;
    const annaId = (await me(anna)).json().user.id;

    const forbidden = await anna.request(
      "POST",
      `/api/v1/admin/users/${annaId}/sessions/revoke`,
      undefined,
      await csrf(anna),
    );
    expect(forbidden.json().code).toBe("forbidden");

    const response = await admin.request(
      "POST",
      `/api/v1/admin/users/${annaId}/sessions/revoke`,
      undefined,
      await csrf(admin),
    );
    expect(response.json()).toEqual({ revoked: 1 });
    expect((await me(anna)).statusCode).toBe(401);
  });
});
