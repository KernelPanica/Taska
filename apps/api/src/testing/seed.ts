import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import { TEST_SPACE, testAccounts, testPeople, testStructure } from "./accounts.js";

/**
 * Тестовые данные для разработки и автотестов (docs/adr/0006): тестовое пространство,
 * тестовые пользователи и структура команды с флагом is_test. Идемпотентно — запускается при каждом старте
 * и не трогает то, что уже есть (в том числе правки, сделанные вручную).
 */
export function seedTestData(db: Database) {
  const now = Date.now();
  const idByEmail = (email: string) =>
    (
      db.prepare("SELECT id FROM users WHERE email = ? AND is_test = 1 ORDER BY created_at LIMIT 1").get(email) as
        | { id: string }
        | undefined
    )?.id ?? null;

  db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO spaces (id, slug, name, is_test, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).run(randomUUID(), TEST_SPACE.slug, TEST_SPACE.name, now, now);
    const spaceId = (db.prepare("SELECT id FROM spaces WHERE slug = ?").get(TEST_SPACE.slug) as { id: string }).id;

    const insertNew = db.prepare(
      `INSERT OR IGNORE INTO users (id, yourspace_subject, email, name, role, locale, is_test, catalog_match, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    // Почта больше не уникальна (её ведёт каталог), поэтому повторный запуск проверяет наличие сам.
    const insertUser = (id: string, subject: string | null, email: string, ...rest: unknown[]) => {
      if (subject && db.prepare("SELECT 1 FROM users WHERE yourspace_subject = ?").get(subject)) return;
      if (!subject && db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return;
      insertNew.run(id, subject, email, ...rest);
    };
    for (const account of testAccounts.filter((item) => item.seeded)) {
      insertUser(
        randomUUID(),
        account.subject,
        account.email,
        account.name,
        account.role,
        account.locale,
        "subject",
        now,
        now,
      );
      // Тестовое пространство — песочница: тестовые аккаунты в нём админы (docs/adr/0014).
      // Права по R-5.2 проверяются в стартовых пространствах («Производство» и др.).
      db.prepare(
        `INSERT OR IGNORE INTO access_grants (id, subject_kind, subject_id, space_id, profile_id, is_test, created_at)
         VALUES (?, 'person', ?, ?, 'profile-space-admin', 1, ?)`,
      ).run(`grant-test-${account.login}`, idByEmail(account.email), spaceId, now);
    }
    for (const person of testPeople)
      insertUser(randomUUID(), null, person.email, person.name, "member", "ru", "unresolved", now, now);

    const groups = [
      {
        items: testStructure.teams.map((team) => ({ ...team, head: team.pm })),
        table: "feature_teams",
        head: "pm_id",
        members: "feature_team_members",
        column: "team_id",
      },
      {
        items: testStructure.guilds.map((guild) => ({ ...guild, head: guild.lead })),
        table: "guilds",
        head: "lead_id",
        members: "guild_members",
        column: "guild_id",
      },
    ];
    for (const group of groups) {
      for (const item of group.items) {
        const exists = db.prepare(`SELECT id FROM ${group.table} WHERE name = ?`).get(item.name);
        if (exists) continue; // уже есть — не перетираем ручные правки
        const id = randomUUID();
        db.prepare(
          `INSERT INTO ${group.table} (id, name, ${group.head}, is_test, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
        ).run(id, item.name, idByEmail(item.head), now, now);
        for (const email of item.members) {
          db.prepare(
            `INSERT OR IGNORE INTO ${group.members} (${group.column}, user_id, created_at) VALUES (?, ?, ?)`,
          ).run(id, idByEmail(email), now);
        }
      }
    }
  })();
}
