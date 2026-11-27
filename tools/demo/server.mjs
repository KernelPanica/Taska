// Демо YourTask: собранное приложение на чистой базе (tools/demo/data), заглушки YourSpace и YourWiki, тестовые данные.
// Запуск: npm run build && node tools/demo/server.mjs, затем node tools/demo/seed.mjs.
import { rmSync } from "node:fs";
const dataDir = new URL("./data/", import.meta.url).pathname;
rmSync(dataDir, { recursive: true, force: true });
process.env.NODE_ENV = "development";
process.env.YOURTASK_DATABASE_PATH = `${dataDir}yourtask.db`;
process.env.YOURTASK_PUBLIC_URL = "http://localhost:3300";
process.env.YOURTASK_LOG_LEVEL = "warn";
// Переключатель сайтов: заглушка YourSpace показывает эти сайты (адреса — для примера).
process.env.YOURSPACE_YOURWIKI_URL = "http://localhost:3200/";
process.env.YOURSPACE_YOURDASH_URL = "http://localhost:3400/";
process.env.HOST = "127.0.0.1";
process.env.PORT = "3300";
await import("../../apps/api/dist/index.js");
