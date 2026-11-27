import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Database = BetterSqlite3.Database;
export type Orm = BetterSQLite3Database<typeof schema>;

/** Версионированные миграции лежат в apps/api/drizzle и применяются при старте (docs/adr/0002). */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function orm(db: Database): Orm {
  return drizzle(db, { schema });
}

/**
 * Применяет только ещё не применённые миграции; повторный вызов ничего не меняет.
 * Внешние ключи на время миграций выключены (так SQLite разрешает пересобирать таблицы
 * без каскадных удалений), после — проверяется целостность всех ссылок.
 */
export function migrate(db: Database): void {
  db.pragma("foreign_keys = OFF");
  try {
    drizzleMigrate(drizzle(db), { migrationsFolder });
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`Migration left ${violations.length} broken foreign key reference(s)`);
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
