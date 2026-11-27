import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers.js";

let app: FastifyInstance;
let webRoot: string;
afterEach(async () => {
  await app?.close();
  await rm(webRoot, { recursive: true, force: true });
});

test("the built web app is served for page navigation, API 404s stay Problem Details", async () => {
  webRoot = await mkdtemp(join(tmpdir(), "yourtask-web-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>YourTask</title>");
  app = await createTestApp({}, { webRoot });

  for (const url of ["/", "/login", "/spaces/test"]) {
    const page = await app.inject({ url, headers: { accept: "text/html" } });
    expect(page.statusCode, url).toBe(200);
    expect(page.body).toContain("<title>YourTask</title>");
  }
  const api = await app.inject({ url: "/api/v1/missing", headers: { accept: "text/html" } });
  expect(api.statusCode).toBe(404);
  expect(api.json().code).toBe("not_found");
});
