import { randomUUID } from "node:crypto";
import { FIELD_KEY_PATTERN, RESERVED_FIELD_KEYS } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError } from "../errors.js";
import { slugify } from "../directory/common.js";

/** Убирает пустые и повторы (без учёта регистра), сохраняя порядок. */
export function normalizeLabels(labels: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    const key = label.toLocaleLowerCase("ru");
    if (!label || seen.has(key)) continue;
    seen.add(key);
    result.push(label);
  }
  return result;
}

/**
 * Заменяет набор значений (варианты списка, значения шкалы), сохраняя id у значений с тем же текстом:
 * на id ссылаются конвертер, шаблоны и тикеты.
 */
export function writeLabels(
  db: Database,
  table: string,
  ownerColumn: string,
  ownerId: string,
  labels: readonly string[],
) {
  const existing = db.prepare(`SELECT id, label FROM ${table} WHERE ${ownerColumn} = ?`).all(ownerId) as {
    id: string;
    label: string;
  }[];
  const byLabel = new Map(existing.map((item) => [item.label.toLocaleLowerCase("ru"), item.id]));
  const keep = new Set<string>();
  const upsert = db.prepare(
    `INSERT INTO ${table} (id, ${ownerColumn}, label, position) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, position = excluded.position`,
  );
  // Сначала сдвигаем позиции и метки во временные, чтобы не упереться в уникальность (owner, label).
  db.prepare(`UPDATE ${table} SET label = id || '#tmp' WHERE ${ownerColumn} = ?`).run(ownerId);
  labels.forEach((label, position) => {
    const id = byLabel.get(label.toLocaleLowerCase("ru")) ?? randomUUID();
    keep.add(id);
    upsert.run(id, ownerId, label, position);
  });
  for (const item of existing) {
    if (!keep.has(item.id)) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(item.id);
  }
}

/** Системное имя для TQL: латиница, `_`; из названия, если не задано. */
export function systemKey(name: string, explicit: string | undefined, fallback: string, field = "key") {
  let key = explicit?.trim() || slugify(name, fallback).replaceAll("-", "_");
  if (!explicit?.trim() && (!/^[a-z]/.test(key) || key.length < 2)) key = `${fallback}_${key}`;
  key = key.slice(0, 40).replace(/_+$/, "");
  if (!new RegExp(FIELD_KEY_PATTERN).test(key)) {
    throw new AppError(400, "validation_failed", "System name must be Latin", [
      { field, message: "latin letters, digits and _; starts with a letter; 2–40 characters" },
    ]);
  }
  if ((RESERVED_FIELD_KEYS as readonly string[]).includes(key)) {
    throw new AppError(400, "validation_failed", `"${key}" is reserved for a built-in ticket attribute`, [
      { field, message: "reserved name" },
    ]);
  }
  return key;
}

export const json = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const placeholders = (items: readonly unknown[]) => items.map(() => "?").join(",");
