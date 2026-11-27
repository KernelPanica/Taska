// Запускает собранный YourTask на чистой базе для e2e: профиль development,
// заглушка YourSpace и тестовые данные — как у нового разработчика.
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(root, "test-results", "e2e-data");
rmSync(dataDir, { recursive: true, force: true });

process.env.NODE_ENV = "development";
process.env.YOURTASK_DATABASE_PATH = resolve(dataDir, "yourtask.db");
process.env.YOURTASK_PUBLIC_URL = "http://127.0.0.1:3100";
process.env.YOURTASK_LOG_LEVEL ??= "warn";
process.env.HOST = "127.0.0.1";
process.env.PORT = "3100";

await import("../apps/api/dist/index.js");
