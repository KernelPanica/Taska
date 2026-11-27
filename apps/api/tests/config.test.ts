import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration profiles", () => {
  test("test profile needs no environment at all", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config).toMatchObject({
      profile: "test",
      databasePath: ":memory:",
      yourspace: { mode: "dev" },
      seedTestData: true,
    });
  });

  test("development works without manual setup and keeps its secret across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yourtask-config-"));
    try {
      const env = { NODE_ENV: "development", YOURTASK_DATABASE_PATH: join(directory, "db.sqlite") };
      const first = loadConfig(env);
      expect(first.yourspace.mode).toBe("dev");
      expect(first.secretKey.length).toBeGreaterThanOrEqual(32);
      expect(loadConfig(env).secretKey).toBe(first.secretKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("production refuses the YourSpace stub, test data and a missing secret", () => {
    const secret = "x".repeat(40);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/SECRET_KEY/);
    expect(() => loadConfig({ NODE_ENV: "production", YOURTASK_SECRET_KEY: secret })).toThrow(/ISSUER/);
    expect(() =>
      loadConfig({ NODE_ENV: "production", YOURTASK_SECRET_KEY: secret, YOURTASK_YOURSPACE_MODE: "dev" }),
    ).toThrow(/stub/);
    const oidc = {
      NODE_ENV: "production",
      YOURTASK_SECRET_KEY: secret,
      YOURTASK_YOURSPACE_ISSUER: "https://id.yourspace.example",
      YOURTASK_YOURSPACE_CLIENT_ID: "yourtask",
      YOURTASK_YOURSPACE_CLIENT_SECRET: "s",
      YOURTASK_DATABASE_PATH: "/data/yourtask.db",
    };
    expect(() => loadConfig({ ...oidc, YOURTASK_SEED_TEST_DATA: "true" })).toThrow(/Test data/);
    expect(loadConfig(oidc)).toMatchObject({ profile: "production", seedTestData: false, yourspace: { mode: "oidc" } });
  });
});
