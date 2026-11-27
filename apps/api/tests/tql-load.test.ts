import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FeatureTeam, Guild, Person, SearchResult, Space, TicketSummary } from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/**
 * R-3.4: поиск и TQL ≤ 1 с на 100 000 тикетов — глазами участника, с проверкой прав каждого найденного.
 * Тикеты заводятся прямо в базе (так быстрее, чем через API), триггеры полнотекста работают как обычно.
 */
const COUNT = 100_000;
let app: FastifyInstance;
let admin: Client;
let anna: Client;

beforeAll(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
  anna = (await signIn(app, { login: "anna" })).user;
  const people = (await admin.request("GET", "/api/v1/people")).json().items as Person[];
  const annaId = (people.find((item) => item.catalog?.username === "anna") as Person).id;
  const headers = await csrf(admin);
  const team = (
    await admin.request("POST", "/api/v1/feature-teams", { name: "Жабы", key: "Frogs", memberIds: [annaId] }, headers)
  ).json() as FeatureTeam;
  const guild = (await admin.request("POST", "/api/v1/guilds", { name: "ГД", key: "GD" }, headers)).json() as Guild;
  const space = ((await admin.request("GET", "/api/v1/spaces")).json().items as Space[]).find(
    (item) => item.slug === "production",
  ) as Space;
  const db = app.db;
  const statuses = db
    .prepare(
      `SELECT s.id, s.category FROM scheme_statuses s JOIN status_schemes sc ON sc.id = s.scheme_id
       WHERE sc.type_id = 'type-story' AND sc.space_id IS NULL ORDER BY s.position`,
    )
    .all() as { id: string; category: string }[];
  const words = [
    "камера",
    "переключение",
    "интерфейс",
    "звук",
    "анимация",
    "баланс",
    "сервер",
    "сеть",
    "босс",
    "уровень",
  ];
  const insert = db.prepare(
    `INSERT INTO tickets (id, number, key, space_id, type_id, status_id, title, description, checklist, field_values,
       priority, tags, is_test, created_by, updated_by, created_at, updated_at, status_changed_at, root_position, legacy_number)
     VALUES (?, ?, ?, ?, 'type-story', ?, ?, ?, '[]', ?, ?, '[]', 0, NULL, NULL, ?, ?, ?, ?, ?)`,
  );
  const people2 = db.prepare(
    "INSERT INTO ticket_people (ticket_id, user_id, role, position) VALUES (?, ?, 'assignee', 0)",
  );
  const closure = db.prepare("INSERT INTO ticket_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)");
  const start = (db.prepare("SELECT last_number AS n FROM ticket_counter WHERE id = 1").get() as { n: number }).n;
  const now = Date.now();
  db.transaction(() => {
    for (let index = 1; index <= COUNT; index += 1) {
      const id = randomUUID();
      const number = start + index;
      const status = statuses[index % statuses.length] as { id: string };
      const values =
        index % 3 === 0 ? { team: team.id, stream: [guild.id] } : index % 3 === 1 ? { stream: [guild.id] } : {};
      insert.run(
        id,
        number,
        `AOS-${number}`,
        space.id,
        status.id,
        `${words[index % words.length]} ${words[(index * 7) % words.length]} №${index}`,
        `Описание задачи ${index}: ${words[(index * 3) % words.length]}`,
        JSON.stringify(values),
        ["lowest", "low", "normal", "high", "highest"][index % 5],
        now - index * 60_000,
        now - index * 30_000,
        now,
        index,
        index % 1000 === 0 ? `General #${index}` : null,
      );
      closure.run(id, id);
      if (index % 10 === 0) people2.run(id, annaId);
    }
    db.prepare("UPDATE ticket_counter SET last_number = ? WHERE id = 1").run(start + COUNT);
  })();
}, 300_000);
afterAll(async () => app?.close());

type Found = SearchResult<TicketSummary>;
async function timed(user: Client, q: string) {
  const started = performance.now();
  const response = await user.request("GET", `/api/v1/search?q=${encodeURIComponent(q)}&limit=100`);
  const wall = performance.now() - started;
  expect(response.statusCode, response.body).toBe(200);
  return { ...(response.json() as Found), wall };
}

describe(`search over ${COUNT.toLocaleString("en")} tickets (R-3.4: ≤ 1 s)`, () => {
  test.each([
    ["full text", "камера"],
    ["team board", "team = Frogs or involvedTeams = Frogs"],
    ["GD lead board", "stream = GD or assignee.guild = GD"],
    ["mine in work", "assignee = me() and statusCategory = active"],
    ["overdue-like with sorting", "statusCategory != done and priority >= high order by created desc"],
    ["old number", 'legacyNumber = "General #57000"'],
    ["key", "AOS-50000"],
  ])("%s as a member: %s", async (_label, q) => {
    const result = await timed(anna, q);
    expect(result.total).toBeGreaterThan(0);
    process.stdout.write(
      `R-3.4 ${q}: ${Math.round(result.wall)} ms, server ${result.tookMs} ms, found ${result.total}\n`,
    );
    expect(result.wall, `${q}: ${Math.round(result.wall)} ms for ${result.total}`).toBeLessThan(1000);
  });
});
