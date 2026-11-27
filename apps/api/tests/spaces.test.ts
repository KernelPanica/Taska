import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, me, signIn } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

describe("spaces and test data", () => {
  test("API returns the test space to test users", async () => {
    app = await createTestApp();
    const { user } = await signIn(app, { login: "ben" });
    const list = (await user.request("GET", "/api/v1/spaces")).json();
    // Тестовое — песочница, где тестовые аккаунты админы; «Инфраструктура» и «Производство» открыты всем
    // стартовыми выдачами, Core — ПМам и лидам (Бен — ПМ Лис) (R-2.16).
    expect(list.items.map((space: { slug: string }) => space.slug)).toEqual([
      "core",
      "infrastructure",
      "production",
      "test",
    ]);
    expect(list.items.find((space: { slug: string }) => space.slug === "test")).toEqual(
      expect.objectContaining({ slug: "test", name: "Тестовое пространство", role: "owner" }),
    );
    const one = await user.request("GET", "/api/v1/spaces/test");
    expect(one.json()).toMatchObject({ slug: "test" });
  });

  test("test space and test users are hidden from regular users", async () => {
    app = await createTestApp();
    const { user } = await signIn(app, { login: "vera" });
    const slugs = (await user.request("GET", "/api/v1/spaces"))
      .json()
      .items.map((space: { slug: string }) => space.slug);
    expect(slugs).toEqual(["infrastructure", "production"]);
    expect((await user.request("GET", "/api/v1/spaces/test")).json().code).toBe("not_found");
  });

  test("an admin email without a second factor in YourSpace cannot sign in", async () => {
    app = await createTestApp({ superadminEmails: ["vera@yourspace.test"] });
    // vera — админ, но без второй проверки в YourSpace → входа нет.
    const { response } = await signIn(app, { login: "vera" });
    expect(response.statusCode).toBe(403);
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await me(anna)).statusCode).toBe(200);
  });

  test("without seeding there is no test data at all", async () => {
    app = await createTestApp({ seedTestData: false });
    const { user } = await signIn(app, { login: "anna" });
    const slugs = (await user.request("GET", "/api/v1/spaces"))
      .json()
      .items.map((space: { slug: string }) => space.slug);
    expect(slugs).toEqual(["infrastructure", "production"]);
  });
});
