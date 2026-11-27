import { loadConfig } from "../src/config.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { seedTestData } from "../src/testing/seed.js";

/** npm run db:migrate — применяет миграции; npm run db:seed — ещё и тестовые данные (не в production). */
const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  migrate(db);
  console.log(`Migrations applied to ${config.databasePath}`);
  if (process.argv.includes("--seed")) {
    if (config.profile === "production") throw new Error("Test data cannot be seeded in production");
    seedTestData(db);
    console.log("Test space and test users are in place");
  }
} finally {
  db.close();
}
