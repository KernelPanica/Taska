import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Board, BoardView, FeatureTeam, Guild, Person, Space } from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/**
 * R-3.4: доска до 500 карточек ≤ 2 с — в базе на 100 000 тикетов, глазами участника, с правами каждого тикета.
 * Тикеты заводятся прямо в базе (так быстрее, чем через API).
 */
const COUNT = 100_000;
const ON_BOARD = 500;
let app: FastifyInstance;
let anna: Client;
let boardId = "";

beforeAll(async () => {
  app = await createTestApp();
  const admin = (await signIn(app, { login: "admin" })).user;
  anna = (await signIn(app, { login: "anna" })).user;
  const people = (await admin.request("GET", "/api/v1/people")).json().items as Person[];
  const annaId = (people.find((item) => item.catalog?.username === "anna") as Person).id;
  const headers = await csrf(admin);
  const frogs = (
    await admin.request("POST", "/api/v1/feature-teams", { name: "Жабы", key: "Frogs", memberIds: [annaId] }, headers)
  ).json() as FeatureTeam;
  const pigs = (
    await admin.request("POST", "/api/v1/feature-teams", { name: "Хрюшки", key: "Pigs" }, headers)
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
  const active = statuses.filter((status) => status.category !== "done");
  const insert = db.prepare(
    `INSERT INTO tickets (id, number, key, space_id, type_id, status_id, title, description, checklist, field_values,
       priority, tags, is_test, created_by, updated_by, created_at, updated_at, status_changed_at, root_position)
     VALUES (?, ?, ?, ?, 'type-story', ?, ?, '', '[]', ?, 'normal', '[]', 0, NULL, NULL, ?, ?, ?, ?)`,
  );
  const assign = db.prepare(
    "INSERT INTO ticket_people (ticket_id, user_id, role, position) VALUES (?, ?, 'assignee', 0)",
  );
  const closure = db.prepare("INSERT INTO ticket_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)");
  const link = db.prepare(
    "INSERT INTO ticket_parents (parent_id, child_id, position, created_by, created_at) VALUES (?, ?, ?, NULL, ?)",
  );
  const start = (db.prepare("SELECT last_number AS n FROM ticket_counter WHERE id = 1").get() as { n: number }).n;
  const now = Date.now();
  const parents: string[] = [];
  db.transaction(() => {
    for (let index = 1; index <= COUNT; index += 1) {
      const id = randomUUID();
      const number = start + index;
      const mine = index <= ON_BOARD;
      const status = (mine ? active[index % active.length] : statuses[index % statuses.length]) as { id: string };
      const values = mine
        ? { team: frogs.id, stream: [guild.id], due_date: "2026-12-01" }
        : index % 2
          ? { team: pigs.id }
          : {};
      insert.run(
        id,
        number,
        `AOS-${number}`,
        space.id,
        status.id,
        `Карточка ${index}`,
        JSON.stringify(values),
        now,
        now,
        now,
        index,
      );
      closure.run(id, id);
      if (mine) {
        assign.run(id, annaId);
        // Дорожки по родителю: 20 эпиков-родителей по 25 карточек.
        if (index <= 20) parents.push(id);
        else link.run(parents[index % 20], id, index, now);
      }
    }
    db.prepare("UPDATE ticket_counter SET last_number = ? WHERE id = 1").run(start + COUNT);
  })();
  const board = (
    await admin.request(
      "POST",
      "/api/v1/boards",
      { name: "Жабы", query: "team = Frogs or involvedTeams = Frogs", spaceId: space.id, lanes: "parent" },
      headers,
    )
  ).json() as Board;
  boardId = board.id;
}, 300_000);
afterAll(async () => app?.close());

describe(`a board of ${ON_BOARD} cards over ${COUNT.toLocaleString("en")} tickets (R-3.4: ≤ 2 s)`, () => {
  test("the Frogs board opens for a member within the limit", async () => {
    // Первый запрос прогревает подготовленные запросы; меряем как пользователь — оба.
    for (const round of [1, 2]) {
      const started = performance.now();
      const response = await anna.request("GET", `/api/v1/boards/${boardId}`);
      const wall = performance.now() - started;
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as BoardView;
      expect(body.cards).toHaveLength(ON_BOARD);
      process.stdout.write(
        `R-3.4 board round ${round}: ${Math.round(wall)} ms, server ${body.tookMs} ms, ${body.cards.length} cards\n`,
      );
      expect(wall, `${Math.round(wall)} ms`).toBeLessThan(2000);
    }
  });
});
