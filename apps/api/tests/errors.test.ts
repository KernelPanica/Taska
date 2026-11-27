import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, signIn } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

function expectProblem(body: Record<string, unknown>, status: number, code: string) {
  expect(body).toMatchObject({ status, code, type: `https://yourtask.dev/errors/${code}` });
  expect(typeof body.title).toBe("string");
  expect(typeof body.requestId).toBe("string");
}

describe("unified error format", () => {
  test("unknown API route returns problem+json", async () => {
    app = await createTestApp();
    const response = await app.inject("/api/v1/nope?x=1");
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expectProblem(response.json(), 404, "not_found");
    expect(response.json().instance).toBe("/api/v1/nope");
    expect(response.json().requestId).toBe(response.headers["x-request-id"]);
  });

  test("missing session is unauthenticated", async () => {
    app = await createTestApp();
    const response = await app.inject("/api/v1/me");
    expect(response.statusCode).toBe(401);
    expectProblem(response.json(), 401, "unauthenticated");
  });

  test("mutation without CSRF header is rejected", async () => {
    app = await createTestApp();
    const { user } = await signIn(app);
    const response = await user.request("PATCH", "/api/v1/me", { locale: "en" });
    expect(response.statusCode).toBe(403);
    expectProblem(response.json(), 403, "csrf_invalid");
  });

  test("validation errors list the offending fields", async () => {
    app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/login?method=carrier-pigeon" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expectProblem(body, 400, "validation_failed");
    expect(body.errors[0].field).toBe("method");
  });
});
