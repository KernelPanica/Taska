import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChromium = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((path) =>
  existsSync(path),
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    locale: "ru-RU",
    trace: "retain-on-failure",
    launchOptions: systemChromium && !process.env.CI ? { executablePath: systemChromium } : {},
  },
  webServer: {
    command: "npm run build && node e2e/server.mjs",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
