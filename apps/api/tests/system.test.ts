import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

describe("system", () => {
  test("health reports service and database status", async () => {
    app = await createTestApp();
    const response = await app.inject("/health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.1.0", database: "ok" });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  test("OpenAPI documents every public endpoint and the Problem schema", async () => {
    app = await createTestApp();
    const spec = (await app.inject("/api/openapi.json")).json();
    expect(spec.info.title).toBe("YourTask API");
    for (const path of [
      "/api/v1/auth/login",
      "/api/v1/auth/callback",
      "/api/v1/auth/logout",
      "/api/v1/me",
      "/api/v1/me/sessions",
      "/api/v1/me/sessions/{sessionId}",
      "/api/v1/me/sessions/revoke-others",
      "/api/v1/admin/users/{userId}/sessions/revoke",
      "/api/v1/spaces",
      "/api/v1/spaces/{slug}",
      "/api/v1/client-errors",
      "/health",
    ]) {
      expect(spec.paths, path).toHaveProperty([path]);
    }
    expect(Object.keys(spec.paths).some((path: string) => path.startsWith("/dev/"))).toBe(false);
    expect(JSON.stringify(spec.components.schemas)).toContain("requestId");
    expect((await app.inject("/api/docs")).statusCode).toBeLessThan(400);
  });

  test("client errors are accepted for logging without a session", async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/client-errors",
      payload: { message: "TypeError: x is undefined", url: "/", client: "web" },
    });
    expect(response.statusCode).toBe(204);
  });
});
