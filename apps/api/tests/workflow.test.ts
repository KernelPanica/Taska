import { describe, expect, test } from "vitest";
import {
  canTransition,
  cancelTarget,
  DEFAULT_OUTCOMES,
  mapStatusOnTypeChange,
  missingRequirements,
  validateScheme,
  type WorkflowStatus,
} from "@yourtask/contracts";

/** YT-05: модульные тесты правил переходов, отмены и переноса статуса при смене типа (R-2.10, R-2.7). */
const status = (
  id: string,
  category: WorkflowStatus["category"],
  extra: Partial<WorkflowStatus> = {},
): WorkflowStatus => ({
  id,
  name: id,
  category,
  waiting: false,
  outcomes: category === "done" ? ["done", "cancelled"] : [],
  requirements: [],
  responsibleRoles: [],
  freezeRequirements: false,
  ...extra,
});

const statuses = [
  status("Backlog", "queue"),
  status("To Do", "queue"),
  status("Creation", "in_progress"),
  status("Creation Done", "in_progress", { waiting: true }),
  status("Done", "done"),
];

describe("transitions", () => {
  test("free by default: any status to any other", () => {
    const scheme = { strictOrder: false, statuses };
    expect(canTransition(scheme, "Backlog", "Done")).toBe(true);
    expect(canTransition(scheme, "Done", "Backlog")).toBe(true);
    expect(canTransition(scheme, "Creation", "To Do")).toBe(true);
  });

  test("strict order: only to the next status or back to any earlier one", () => {
    const scheme = { strictOrder: true, statuses };
    expect(canTransition(scheme, "Backlog", "To Do")).toBe(true);
    expect(canTransition(scheme, "Backlog", "Creation")).toBe(false);
    expect(canTransition(scheme, "Creation Done", "Backlog")).toBe(true);
    expect(canTransition(scheme, "Creation Done", "Done")).toBe(true);
  });

  test("the same or an unknown target is not a transition", () => {
    const scheme = { strictOrder: false, statuses };
    expect(canTransition(scheme, "To Do", "To Do")).toBe(false);
    expect(canTransition(scheme, "To Do", "Nowhere")).toBe(false);
  });
});

describe("cancelling", () => {
  test("leads to the first done status that allows «cancelled», from anywhere", () => {
    const scheme = {
      statuses: [
        status("Backlog", "queue"),
        status("Released", "done", { outcomes: ["done"] }),
        status("Closed", "done"),
      ],
    };
    expect(cancelTarget(scheme)?.id).toBe("Closed");
  });

  test("a scheme without such a status cannot be saved", () => {
    const problems = validateScheme(
      { statuses: [status("Backlog", "queue"), status("Done", "done", { outcomes: ["done"] })] },
      DEFAULT_OUTCOMES,
    );
    expect(problems.map((problem) => problem.message).join()).toContain('"cancelled"');
  });
});

describe("scheme validation", () => {
  test("every status needs a category; a done status needs an outcome", () => {
    const problems = validateScheme(
      {
        statuses: [
          { name: "Без категории", outcomes: [] },
          { name: "Готово", category: "done", outcomes: [] },
          { name: "Закрыто", category: "done", outcomes: ["cancelled"] },
        ],
      },
      DEFAULT_OUTCOMES,
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        { field: "statuses/0/category", message: "a status needs a category" },
        { field: "statuses/1/outcomes", message: "a done status needs at least one outcome" },
      ]),
    );
  });

  test("outcomes belong to done statuses and to the type; names are unique", () => {
    const problems = validateScheme(
      {
        statuses: [
          { name: "Test", category: "in_progress", outcomes: ["done"] },
          { name: "test", category: "queue", outcomes: [] },
          { name: "Done", category: "done", outcomes: ["fixed", "cancelled"] },
        ],
      },
      DEFAULT_OUTCOMES,
    );
    expect(problems.map((problem) => problem.message)).toEqual([
      "only a done status has outcomes",
      "status names must be unique",
      'unknown outcome "fixed"',
    ]);
  });

  test("a valid start scheme has no problems", () => {
    expect(validateScheme({ statuses }, DEFAULT_OUTCOMES)).toEqual([]);
  });
});

describe("entry requirements", () => {
  const ticket = {
    values: { size: "t-M", estimate_days: null, tags: [] as string[] },
    description: "  ",
    checklist: [{ done: true }, { done: false }],
    people: { assignees: [], customer: null, tester: { id: "u1" } },
  };
  test("lists what is missing", () => {
    const target = status("To Do", "queue", {
      requirements: [
        { kind: "field", fieldKey: "size" },
        { kind: "field", fieldKey: "estimate_days" },
        { kind: "field", fieldKey: "tags" },
        { kind: "people", role: "assignees" },
        { kind: "people", role: "tester" },
        { kind: "description" },
        { kind: "checklist_done" },
      ],
    });
    expect(missingRequirements(target, ticket)).toEqual([
      { kind: "field", fieldKey: "estimate_days" },
      { kind: "field", fieldKey: "tags" },
      { kind: "people", role: "assignees" },
      { kind: "description" },
      { kind: "checklist_done" },
    ]);
  });
  test("nothing required — nothing missing", () => {
    expect(missingRequirements(status("Backlog", "queue"), ticket)).toEqual([]);
  });
});

describe("status on type change (R-2.7)", () => {
  const bug = [
    status("b-backlog", "queue", { name: "Backlog" }),
    status("b-impl", "in_progress", { name: "Implementation" }),
    status("b-test", "in_progress", { name: "Test" }),
    status("b-done", "done", { name: "Done" }),
  ];
  test("by name first, ignoring case", () => {
    expect(mapStatusOnTypeChange({ name: "test", category: "in_progress" }, bug)).toEqual({
      kind: "name",
      statusId: "b-test",
    });
  });
  test("then by category when exactly one status fits", () => {
    expect(mapStatusOnTypeChange({ name: "To Do", category: "queue" }, bug)).toEqual({
      kind: "category",
      statusId: "b-backlog",
    });
  });
  test("otherwise asks, offering the statuses of the same category", () => {
    expect(mapStatusOnTypeChange({ name: "Creation", category: "in_progress" }, bug)).toEqual({
      kind: "ask",
      candidates: ["b-impl", "b-test"],
    });
  });
  test("asks with every status when no category matches", () => {
    expect(mapStatusOnTypeChange({ name: "Ждём", category: "queue" }, bug.slice(1))).toEqual({
      kind: "ask",
      candidates: ["b-impl", "b-test", "b-done"],
    });
  });
});
