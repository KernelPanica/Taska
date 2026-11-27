import { randomBytes } from "node:crypto";
import type { PersonRef } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError } from "../errors.js";
import type { UserRow } from "../auth/sessions.js";

/**
 * Видимость тестовых данных (docs/adr/0006): обычный пользователь не видит тестовых сущностей,
 * тестовый видит всё. Возвращает SQL-условие для столбца is_test.
 */
export function visibleSql(viewer: UserRow, column = "is_test") {
  return viewer.isTest ? "1 = 1" : `${column} = 0`;
}

/** Всё, что создаёт тестовый пользователь, — тоже тестовое: реальные пользователи этого не увидят. */
export function createdAsTest(viewer: UserRow) {
  return viewer.isTest ? 1 : 0;
}

export function isUniqueViolation(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as { code: unknown }).code) === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Проверяет, что все люди существуют и видны; иначе — validation_failed по полю. */
export function requireVisiblePeople(db: Database, viewer: UserRow, ids: readonly string[], field: string) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return unique;
  const placeholders = unique.map(() => "?").join(",");
  const found = db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND ${visibleSql(viewer)}`)
    .all(...unique) as { id: string }[];
  if (found.length !== unique.length) {
    const known = new Set(found.map((row) => row.id));
    const missing = unique.filter((id) => !known.has(id));
    throw new AppError(400, "validation_failed", "Unknown person", [
      { field, message: `unknown person: ${missing.join(", ")}` },
    ]);
  }
  return unique;
}

export function personRefs(db: Database, sql: string, ...params: unknown[]): PersonRef[] {
  return (db.prepare(sql).all(...params) as PersonRefRow[]).map(toPersonRef);
}

const TRANSLIT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** Латинский идентификатор из названия: «Дирекция продукта» → direktsiya-produkta. */
export function slugify(value: string, fallbackPrefix: string) {
  const slug = value
    .toLowerCase()
    .split("")
    .map((char) => TRANSLIT[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `${fallbackPrefix}-${randomBytes(3).toString("hex")}`;
}

export const nameSchema = { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" } as const;
export const idListSchema = { type: "array", maxItems: 1000, items: { type: "string", maxLength: 64 } } as const;
export const personRefSchema = {
  type: "object",
  required: ["id", "name", "email", "deactivated"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: { type: ["string", "null"] },
    deactivated: { type: "boolean" },
  },
} as const;

/** Строка SQL с `deactivated_at IS NOT NULL AS deactivated` (SQLite отдаёт 0/1). */
export interface PersonRefRow {
  id: string;
  name: string;
  email: string | null;
  deactivated: number | boolean;
}

export const toPersonRef = ({ id, name, email, deactivated }: PersonRefRow): PersonRef => ({
  id,
  name,
  email,
  deactivated: Boolean(deactivated),
});
export const groupRefSchema = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "string" }, name: { type: "string" } },
} as const;
export const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", maxLength: 64 } },
} as const;
