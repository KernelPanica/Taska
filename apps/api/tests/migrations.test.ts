import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { migrate, migrationsFolder, openDatabase } from "../src/db/index.js";

const journal = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
import { seedTestData } from "../src/testing/seed.js";

function schemaOf(db: ReturnType<typeof openDatabase>) {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

describe("versioned migrations", () => {
  test("apply on a clean database and a second run changes nothing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yourtask-migrations-"));
    const path = join(directory, "yourtask.db");
    try {
      let db = openDatabase(path);
      migrate(db);
      seedTestData(db);
      const first = schemaOf(db);
      const users = db.prepare("SELECT count(*) AS n FROM users").get();
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      for (const table of [
        "users",
        "sessions",
        "auth_flows",
        "spaces",
        "access_grants",
        "access_profiles",
        "ticket_closure",
        "__drizzle_migrations",
      ]) {
        expect(
          first.some((item) => (item as { name: string }).name === table),
          table,
        ).toBe(true);
      }
      db.close();

      db = openDatabase(path);
      migrate(db);
      seedTestData(db);
      expect(schemaOf(db)).toEqual(first);
      expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual(users);
      expect(db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: journal.entries.length });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("upgrade from the YT-01 schema keeps users, sessions and memberships (as grants)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yourtask-upgrade-"));
    try {
      // Папка только с первой миграцией — состояние базы после YT-01.
      const first = join(directory, "migrations");
      await mkdir(join(first, "meta"), { recursive: true });
      await copyFile(join(migrationsFolder, "0000_init.sql"), join(first, "0000_init.sql"));
      await writeFile(
        join(first, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
      );
      const path = join(directory, "yourtask.db");
      const old = new BetterSqlite3(path);
      old.pragma("foreign_keys = ON");
      drizzleMigrate(drizzle(old), { migrationsFolder: first });
      old
        .prepare(
          "INSERT INTO users (id, yourspace_subject, email, name, created_at, updated_at) VALUES ('u1', 'sub', 'A@Example.com', 'A', 1, 1)",
        )
        .run();
      old
        .prepare(
          "INSERT INTO sessions (id, user_id, token_hash, csrf_token, method, created_at, last_seen_at, expires_at) VALUES ('s1', 'u1', 'h', 'c', 'password', 1, 1, 9999999999999)",
        )
        .run();
      old.prepare("INSERT INTO spaces (id, slug, name, created_at, updated_at) VALUES ('sp', 'x', 'X', 1, 1)").run();
      old.prepare("INSERT INTO space_members (space_id, user_id, created_at) VALUES ('sp', 'u1', 1)").run();
      old.close();

      const db = openDatabase(path);
      migrate(db);
      expect(db.prepare("SELECT email, wip_limit FROM users WHERE id = 'u1'").get()).toEqual({
        email: "a@example.com",
        wip_limit: null,
      });
      expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 1 });
      // Участник пространства YT-01 стал выдачей «человек × пространство × Участник» (YT-08).
      expect(
        db.prepare("SELECT subject_id, space_id, profile_id FROM access_grants WHERE space_id = 'sp'").all(),
      ).toEqual([{ subject_id: "u1", space_id: "sp", profile_id: "profile-member" }]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.prepare("SELECT name FROM spaces WHERE is_test = 0 AND slug != 'x' ORDER BY slug").all()).toEqual([
        { name: "Core" },
        { name: "Дирекция" },
        { name: "Инфраструктура" },
        { name: "Производство" },
      ]);
      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("upgrade from the YT-02 schema keeps people, groups and sessions and marks unmatched people", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yourtask-upgrade-yt02-"));
    try {
      const previous = join(directory, "migrations");
      await mkdir(join(previous, "meta"), { recursive: true });
      for (const entry of journal.entries.slice(0, 2)) {
        await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
      }
      await writeFile(
        join(previous, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
      );
      const path = join(directory, "yourtask.db");
      const old = new BetterSqlite3(path);
      old.pragma("foreign_keys = ON");
      drizzleMigrate(drizzle(old), { migrationsFolder: previous });
      const insert = old.prepare(
        "INSERT INTO users (id, yourspace_subject, email, name, wip_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
      );
      insert.run("linked", "sub-1", "l@example.com", "Linked", 3);
      insert.run("manual", null, "m@example.com", "Manual", null);
      old
        .prepare(
          "INSERT INTO sessions (id, user_id, token_hash, csrf_token, method, created_at, last_seen_at, expires_at) VALUES ('s1', 'linked', 'h', 'c', 'password', 1, 1, 9999999999999)",
        )
        .run();
      old
        .prepare("INSERT INTO guilds (id, name, lead_id, created_at, updated_at) VALUES ('g', 'G', 'manual', 1, 1)")
        .run();
      old.prepare("INSERT INTO guild_members (guild_id, user_id, created_at) VALUES ('g', 'linked', 1)").run();
      old.close();

      const db = openDatabase(path);
      migrate(db);
      expect(
        db.prepare("SELECT id, email, wip_limit, catalog_match, deactivated_at FROM users ORDER BY id").all(),
      ).toEqual([
        { id: "linked", email: "l@example.com", wip_limit: 3, catalog_match: "subject", deactivated_at: null },
        { id: "manual", email: "m@example.com", wip_limit: null, catalog_match: "unresolved", deactivated_at: null },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT lead_id FROM guilds").get()).toEqual({ lead_id: "manual" });
      expect(db.prepare("SELECT count(*) AS n FROM guild_members").get()).toEqual({ n: 1 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("YourTask has no column for passwords or other sign-in secrets", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const columns = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    expect(
      columns.map((column) => column.name).filter((name) => /pass|secret|otp|hash|phone|birth/i.test(name)),
    ).toEqual([]);
    db.close();
  });
});
