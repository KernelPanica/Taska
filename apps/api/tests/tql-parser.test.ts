import { describe, expect, test } from "vitest";
import {
  checkTql,
  completeTql,
  parseTql,
  printTql,
  searchToTql,
  valueFromInput,
  zoneStatuses,
  type TqlQuery,
} from "@yourtask/contracts";

/** YT-15: один разборщик TQL (R-2.28, R-5.3) — разбор, канонический текст, ошибки, подсказки. */
const EXAMPLES = [
  "team = Frogs or involvedTeams = Frogs",
  "stream = GD or assignee.guild = GD",
  "assignee = me() and statusCategory = active",
  "due < today() and statusCategory != done",
  "branch(AOS-201) and zone = Delivery",
  "type = Bug and causedBy(AOS-418)",
  "priority = Urgent",
  'legacyNumber = "General #57"',
];

describe("TQL parser (R-5.3)", () => {
  test.each(EXAMPLES)("the reference example «%s» parses and prints back unchanged", (text) => {
    const query = parseTql(text);
    expect(printTql(query)).toBe(text);
    expect(parseTql(printTql(query))).toEqual(query);
  });

  test("operators, logic, groups, functions and sorting; keywords in any case", () => {
    const query = parseTql(
      'NOT (status IN ("To Do", Test) Or priority >= high) AND created >= daysAgo(7) and assignee is not empty ORDER BY due desc, key',
    );
    expect(printTql(query)).toBe(
      'not (status in ("To Do", Test) or priority >= high) and created >= daysAgo(7) and assignee is not empty order by due desc, key asc',
    );
    expect(query.orderBy).toEqual([
      { field: "due", dir: "desc" },
      { field: "key", dir: "asc" },
    ]);
    expect(
      parseTql('text ~ "камера" and linkedTo(AOS-5, blocks) and team not in (Frogs, "Хрюшки")').where,
    ).toMatchObject({
      kind: "and",
      items: [
        { kind: "cond", field: "text", op: "~" },
        { kind: "pred", name: "linkedTo", args: [{ text: "AOS-5" }, { text: "blocks" }] },
        { kind: "cond", field: "team", op: "not in", values: [{ text: "Frogs" }, { kind: "string", text: "Хрюшки" }] },
      ],
    });
  });

  test("chips → text → chips: any tree prints to text that parses back into the same tree", () => {
    const tree: TqlQuery = {
      where: {
        kind: "or",
        items: [
          { kind: "cond", field: "stream", op: "=", value: valueFromInput("ГД") },
          { kind: "cond", field: "assignee.guild", op: "=", value: valueFromInput("GD") },
          {
            kind: "group",
            item: {
              kind: "and",
              items: [
                { kind: "cond", field: "due", op: "<", value: valueFromInput("today()") },
                { kind: "not", item: { kind: "pred", name: "branch", args: [valueFromInput("AOS-1")] } },
              ],
            },
          },
        ],
      },
      orderBy: [{ field: "priority", dir: "desc" }],
    };
    const text = printTql(tree);
    expect(text).toBe(
      'stream = "ГД" or assignee.guild = GD or (due < today() and not branch(AOS-1)) order by priority desc',
    );
    expect(parseTql(text)).toEqual(tree);
  });

  test.each([
    ["staus = Test", "unknown_field", 0, 5, "status"],
    ["team = Жабы", "unquoted_text", 7, 11, '"Жабы"'],
    ["team > Frogs", "operator_not_allowed", 5, 6, "team"],
    ["status = ", "expected_value", 9, 10, undefined],
    ['title = "камера', "unterminated_string", 8, 15, undefined],
    ["brunch(AOS-1)", "unknown_function", 0, 6, "branch"],
    ["status = Test and", "unexpected_end", 17, 18, undefined],
    ["status Test", "expected_operator", 7, 11, "="],
    ["type = Bug order key", "unexpected_token", 17, 20, "by"],
    ["created > daysAgo()", "wrong_arguments", 10, 19, undefined],
    ["text = камера", "unquoted_text", 7, 13, '"камера"'],
  ])("«%s» is an error %s at [%i, %i) with the hint %s", (text, code, start, end, suggestion) => {
    const result = checkTql(text, { customFields: ["title"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatchObject({ code, start, end });
    if (suggestion) expect(result.problem.suggestion).toBe(suggestion);
  });

  test("plain words in the search box are full-text search; a broken query stays an error", () => {
    expect(printTql(searchToTql("камера дёргается"))).toBe('text ~ "камера дёргается"');
    expect(printTql(searchToTql("AOS-27"))).toBe('text ~ "AOS-27"');
    expect(() => searchToTql("status = ")).toThrow();
  });

  test("autocomplete offers fields, then the operators of the field, then its values and functions, then logic", () => {
    const labels = (text: string) =>
      completeTql(text, text.length, {
        values: (field) => (field.name === "stream" ? [{ name: "GD", label: "ГД" }] : []),
      }).items.map((item) => item.label);
    expect(labels("str")).toEqual(["stream"]);
    expect(labels("stream ")).toEqual(["=", "!=", "in", "not in", "is empty", "is not empty"]);
    expect(labels("stream = ")).toEqual(["ГД · GD", "myGuilds()"]);
    expect(labels("stream = GD ")).toEqual(["and", "or", "order by"]);
    expect(labels("stream = GD or assignee.g")).toEqual(["assignee.guild"]);
    expect(labels("stream = GD or bra")).toEqual(["branch()"]);
  });

  test("the starter zone tree of R-5.1: Delivery covers To Do, elaboration, production and test", () => {
    expect(zoneStatuses("Delivery")).toEqual(
      expect.arrayContaining(["To Do", "Analysis", "Design Done", "Creation", "Implementation Done", "Test"]),
    );
    expect(zoneStatuses("Delivery")).not.toContain("Backlog");
    expect(zoneStatuses("Discovery")).toEqual(["Backlog", "Discovery", "Discovery Done"]);
  });
});
