import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Locale, User } from "@yourtask/contracts";
import type { Orm } from "../db/index.js";
import { users } from "../db/schema.js";
import type { Identity } from "../auth/provider.js";
import type { UserRow } from "../auth/sessions.js";

export function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, locale: row.locale };
}

/**
 * Находит или создаёт человека YourTask по аккаунту YourSpace при входе.
 * Обычно человек уже есть: его создала синхронизация каталога, а перед входом профиль перечитан
 * (docs/adr/0009). Создаём здесь, только если каталог был недоступен. По почте не связываем: сопоставление
 * людей, заведённых до перехода, — дело синхронизации и отчёта.
 */
export function provisionUser(orm: Orm, identity: Identity, superadminEmails: readonly string[]): UserRow {
  const now = Date.now();
  const email = identity.email.toLowerCase();
  const promote = identity.role === "superadmin" || superadminEmails.includes(email);
  const existing = orm.select().from(users).where(eq(users.yourspaceSubject, identity.subject)).get();
  if (existing) {
    return orm
      .update(users)
      .set({ lastLoginAt: now, ...(promote ? { role: "superadmin" as const } : {}) })
      .where(eq(users.id, existing.id))
      .returning()
      .get();
  }
  return orm
    .insert(users)
    .values({
      id: randomUUID(),
      yourspaceSubject: identity.subject,
      email,
      name: identity.name,
      role: promote ? "superadmin" : "member",
      locale: identity.locale ?? "ru",
      isTest: false,
      catalogMatch: "created",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .returning()
    .get();
}

export function setLocale(orm: Orm, userId: string, locale: Locale): UserRow {
  return orm.update(users).set({ locale, updatedAt: Date.now() }).where(eq(users.id, userId)).returning().get();
}
