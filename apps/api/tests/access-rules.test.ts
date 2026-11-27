import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  accessLevel,
  computeProgress,
  datesRollup,
  ownRestrictions,
  R52_MATRIX,
  RIGHTS,
  rightAllows,
  starterRights,
  STARTER_PROFILE_KEYS,
  statusRollup,
  type Right,
  type ScopeContext,
  type ScopeTicket,
  type StarterProfileKey,
} from "@yourtask/contracts";
import BetterSqlite3 from "better-sqlite3";
import { migrate } from "../src/db/index.js";

/**
 * Модульные тесты бизнес-правил (R-3.5): права по каждой строке матрицы R-5.2 (YT-08),
 * видимость, свёртки прогресса, статуса и дат (YT-10).
 */

// Контекст выдачи: человек в команде «Жабы» и в колодце «ГД».
const me: ScopeContext = { userId: "me", teams: new Set(["toads"]), guilds: new Set(["gd"]) };
const ticket = (patch: Partial<ScopeTicket>): ScopeTicket => ({
  team: null,
  streams: [],
  createdBy: "someone",
  category: "in_progress",
  ...patch,
});

/** Тикеты, на которых различаются области R-5.2. */
const CASES = {
  ownTeam: ticket({ team: "toads" }),
  otherTeamMyStream: ticket({ team: "pigs", streams: ["gd"] }),
  noTeamMyStream: ticket({ streams: ["gd"] }),
  foreign: ticket({ team: "pigs", streams: ["art"] }),
  mineQueued: ticket({ team: "pigs", createdBy: "me", category: "queue" }),
  mineInWork: ticket({ team: "pigs", createdBy: "me", category: "in_progress" }),
  deletedByMe: ticket({ team: "pigs", deletedBy: "me" }),
} as const;
type Case = keyof typeof CASES;

/** Что ожидаем от области, записанной в матрице, на каждом тикете. */
const EXPECTED: Record<string, Case[]> = {
  all: Object.keys(CASES) as Case[],
  team: ["ownTeam"],
  stream: ["otherTeamMyStream", "noTeamMyStream"],
  no_team: ["noTeamMyStream"],
  own_queued: ["mineQueued"],
  own_deleted: ["deletedByMe"],
};

describe("R-5.2: every row of the rights matrix", () => {
  for (const right of RIGHTS) {
    test(`row «${right}»`, () => {
      for (const profile of STARTER_PROFILE_KEYS) {
        const rights = starterRights(profile);
        const scopes = R52_MATRIX[right][profile];
        for (const [name, subject] of Object.entries(CASES) as [Case, ScopeTicket][]) {
          const expected = scopes
            ? scopes.some(
                (scope) => (EXPECTED[scope] ?? []).includes(name) || (scope === "own" && subject.createdBy === "me"),
              )
            : false;
          expect(rightAllows(rights, right, me, subject), `${profile} · ${right} · ${name}`).toBe(expected);
        }
      }
    });
  }

  test("the matrix says what R-5.2 says (spot checks of the document)", () => {
    const allows = (profile: StarterProfileKey, right: Right, at: Case) =>
      rightAllows(starterRights(profile), right, me, CASES[at]);
    // Участник правит тикеты своей команды, но не меняет видимость и не удаляет чужой тикет в работе.
    expect(allows("member", "edit", "ownTeam")).toBe(true);
    expect(allows("member", "visibility", "ownTeam")).toBe(false);
    expect(allows("member", "trash", "ownTeam")).toBe(false);
    expect(allows("member", "trash", "mineQueued")).toBe(true);
    expect(allows("member", "trash", "mineInWork")).toBe(false);
    // Лид колодца правит описание тикета своего стрима в чужой команде, но не исполнителя.
    expect(allows("guild_lead", "edit", "otherTeamMyStream")).toBe(true);
    expect(allows("guild_lead", "assign", "otherTeamMyStream")).toBe(false);
    // В тикетах без команды лид колодца имеет права ПМа.
    for (const right of ["status", "assign", "dates"] as const)
      expect(allows("guild_lead", right, "noTeamMyStream")).toBe(true);
    // Наблюдатель только смотрит и комментирует.
    expect(allows("observer", "comment", "foreign")).toBe(true);
    expect(allows("observer", "create", "foreign")).toBe(false);
    // Окончательно удаляет только суперадмин; экспорт — суперадмин и админ пространства.
    expect(STARTER_PROFILE_KEYS.filter((profile) => allows(profile, "purge", "foreign"))).toEqual(["superadmin"]);
    expect(STARTER_PROFILE_KEYS.filter((profile) => allows(profile, "export", "foreign"))).toEqual([
      "superadmin",
      "space_admin",
    ]);
  });

  test("the migration creates the six starter profiles exactly as the matrix", () => {
    const db = new BetterSqlite3(":memory:");
    migrate(db);
    const rows = db.prepare("SELECT key, rights FROM access_profiles WHERE is_system = 1").all() as {
      key: StarterProfileKey;
      rights: string;
    }[];
    expect(rows.map((row) => row.key).sort()).toEqual([...STARTER_PROFILE_KEYS].sort());
    for (const row of rows) expect(JSON.parse(row.rights), row.key).toEqual(starterRights(row.key));
    db.close();
  });

  test("the migration file is the source the test above reads", () => {
    expect(readFileSync(new URL("../drizzle/0007_access.sql", import.meta.url), "utf8")).toContain(
      "profile-guild-lead",
    );
  });
});

describe("visibility (R-2.20)", () => {
  test("title only: the ticket itself shows the title, its descendants are hidden", () => {
    const epic = { sourceId: "epic", visibility: "title_only" as const, exempt: false };
    expect(accessLevel("epic", [epic])).toBe("title");
    expect(accessLevel("story", [epic])).toBe("none");
    expect(accessLevel("story", [{ ...epic, exempt: true }])).toBe("full");
    expect(accessLevel("x", [{ sourceId: "x", visibility: "hidden", exempt: false }])).toBe("none");
    expect(accessLevel("x", [])).toBe("full");
  });

  test("an explicit setting of a descendant wins over the inherited one", () => {
    expect(ownRestrictions("story", null, ["epic"])).toEqual(["epic"]);
    expect(ownRestrictions("story", "open", ["epic"])).toEqual([]);
    expect(ownRestrictions("story", "hidden", ["epic"])).toEqual(["story"]);
  });
});

describe("rollups (R-2.12)", () => {
  const child = (
    id: string,
    category: "queue" | "in_progress" | "done",
    outcome: string | null = null,
    weight: number | null = null,
  ) => ({
    id,
    category,
    outcome,
    weight,
  });

  test("three children and two own checklist items: equal weights, a checklist child counted once", () => {
    const progress = computeProgress(
      "both",
      false,
      "in_progress",
      [{ done: true }, { done: false }, { done: false, childId: "a" }],
      [child("a", "done", "fixed"), child("b", "done", "fixed"), child("c", "in_progress")],
    );
    // 2 пункта + 3 ребёнка = 5 единиц; готовы: пункт 1, a (через чеклист), b.
    expect(progress).toEqual({ done: 3, total: 5, percent: 60 });
  });

  test("a cancelled child does not pull the progress down", () => {
    const progress = computeProgress(
      "children",
      false,
      "in_progress",
      [],
      [child("a", "done", "fixed"), child("b", "done", "cancelled")],
    );
    expect(progress).toEqual({ done: 1, total: 1, percent: 100 });
  });

  test("weights by estimate; a child without an estimate gets the average", () => {
    const progress = computeProgress(
      "children",
      true,
      "in_progress",
      [],
      [child("a", "done", "fixed", 8), child("b", "queue", null, 2), child("c", "queue")],
    );
    expect(progress).toEqual({ done: 8, total: 15, percent: 53 });
  });

  test("status: the first child in work starts the parent; all closed raises the flag; a reopened child reopens the parent", () => {
    expect(
      statusRollup("queue", [
        { category: "in_progress", outcome: null },
        { category: "queue", outcome: null },
      ]),
    ).toEqual({
      action: "start",
      suggestClose: false,
    });
    expect(
      statusRollup("in_progress", [
        { category: "done", outcome: "fixed" },
        { category: "done", outcome: "cancelled" },
      ]),
    ).toEqual({
      action: null,
      suggestClose: true,
    });
    expect(statusRollup("done", [{ category: "in_progress", outcome: null }])).toEqual({
      action: "reopen",
      suggestClose: false,
    });
    expect(statusRollup("done", [{ category: "done", outcome: "fixed" }])).toEqual({
      action: null,
      suggestClose: false,
    });
  });

  test("dates: the earliest start and the latest end of the children", () => {
    expect(
      datesRollup([
        { start: "2026-11-03", end: "2026-11-10" },
        { start: "2026-11-05", end: "2026-11-21" },
        { start: null, end: null },
      ]),
    ).toEqual({ start: "2026-11-03", end: "2026-11-21" });
  });
});
