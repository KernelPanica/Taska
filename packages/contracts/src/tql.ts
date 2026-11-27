/**
 * TQL — язык запросов YourTask (R-2.28, R-5.3; YT-15, docs/adr/0021).
 *
 * Один разборщик для всех мест: поиск, чипы, доски, правила, подписки, помощник. Сервер исполняет
 * то же дерево, что строит интерфейс, поэтому «чипы → текст → чипы» и «текст → сервер» не расходятся.
 * Ключевые слова, функции и имена полей — только английские; регистр ключевых слов не важен.
 * Значения — системное имя латиницей или отображаемое имя в кавычках.
 */

// ---- Дерево запроса ----

export type TqlValue =
  | { kind: "word"; text: string }
  | { kind: "string"; text: string }
  | { kind: "number"; value: number }
  | { kind: "call"; name: string; args: TqlValue[] };

export type TqlOperator = "=" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "not in" | "~" | "is empty" | "is not empty";

export type TqlExpr =
  | { kind: "cond"; field: string; op: TqlOperator; value?: TqlValue; values?: TqlValue[] }
  | { kind: "pred"; name: string; args: TqlValue[] }
  | { kind: "and"; items: TqlExpr[] }
  | { kind: "or"; items: TqlExpr[] }
  | { kind: "not"; item: TqlExpr }
  | { kind: "group"; item: TqlExpr };

export interface TqlOrder {
  field: string;
  dir: "asc" | "desc";
}

export interface TqlQuery {
  where: TqlExpr | null;
  orderBy: TqlOrder[];
}

// ---- Каталог полей и функций (R-5.3) ----

export type TqlFieldKind =
  | "key"
  | "enum"
  | "team"
  | "guild"
  | "person"
  | "date"
  | "datetime"
  | "number"
  | "bool"
  | "text"
  | "fulltext"
  | "custom";

export interface TqlFieldInfo {
  name: string;
  kind: TqlFieldKind;
  /** Поле приходит с другой карточкой; до неё значение пусто (можно искать «is empty»). */
  pending?: string;
  /** Можно сортировать (order by). */
  sortable?: boolean;
  /** Несколько значений: «=» значит «среди значений есть». */
  multi?: boolean;
}

const f = (name: string, kind: TqlFieldKind, extra: Partial<TqlFieldInfo> = {}): TqlFieldInfo => ({
  name,
  kind,
  ...extra,
});

/** Поля R-5.3 в порядке справочника. Свои поля типа — по системному имени (kind «custom»). */
export const TQL_FIELDS: readonly TqlFieldInfo[] = [
  f("key", "key", { sortable: true }),
  f("type", "enum", { sortable: true }),
  f("status", "enum", { sortable: true }),
  f("statusCategory", "enum", { sortable: true }),
  f("resolution", "enum"),
  f("zone", "enum"),
  f("space", "enum", { sortable: true }),
  f("team", "team", { sortable: true }),
  f("stream", "guild", { multi: true }),
  f("assignee", "person", { multi: true }),
  f("reporter", "person"),
  f("watcher", "person", { multi: true }),
  f("priority", "enum", { sortable: true }),
  f("estimate", "custom"),
  f("start", "date", { sortable: true }),
  f("due", "date", { sortable: true }),
  f("created", "datetime", { sortable: true }),
  f("updated", "datetime", { sortable: true }),
  f("archived", "bool"),
  f("legacyNumber", "text", { sortable: true }),
  f("involvedTeams", "team", { multi: true }),
  f("coordinator", "person", { pending: "R-2.29" }),
  f("owner", "person", { pending: "R-2.30" }),
  f("tester", "person"),
  f("rework", "bool", { pending: "R-2.30" }),
  f("foundIn", "custom", { pending: "R-2.30" }),
  f("bugDecision", "custom", { pending: "R-2.30" }),
  f("reworkRounds", "number", { pending: "R-2.30" }),
  f("fixState", "custom", { pending: "R-2.30" }),
  f("tenure", "number", { pending: "R-2.34" }),
  f("dueShifts", "number", { sortable: true }),
  f("actualStart", "datetime", { sortable: true }),
  f("actualEnd", "datetime", { sortable: true }),
  f("text", "fulltext"),
];

/** Поля человека через точку: assignee.guild, assignee.team (R-5.3). */
export const TQL_PERSON_PARTS = { guild: "guild", team: "team" } as const;

const FIELD_BY_LOWER = new Map(TQL_FIELDS.map((field) => [field.name.toLowerCase(), field]));

/** Поле по имени без учёта регистра; «assignee.guild» — поле человека через точку. */
export function tqlField(name: string): TqlFieldInfo | null {
  const lower = name.toLowerCase();
  const known = FIELD_BY_LOWER.get(lower);
  if (known) return known;
  const [base, part, ...rest] = lower.split(".");
  if (rest.length || !base || !part) return null;
  const person = FIELD_BY_LOWER.get(base);
  if (person?.kind !== "person" || !(part in TQL_PERSON_PARTS)) return null;
  const kind = TQL_PERSON_PARTS[part as keyof typeof TQL_PERSON_PARTS];
  return { name: `${person.name}.${part}`, kind, multi: true };
}

export const TQL_OPERATORS_BY_KIND: Record<TqlFieldKind, readonly TqlOperator[]> = {
  key: ["=", "!=", "in", "not in", ">", "<", ">=", "<="],
  enum: ["=", "!=", "in", "not in", "is empty", "is not empty"],
  team: ["=", "!=", "in", "not in", "is empty", "is not empty"],
  guild: ["=", "!=", "in", "not in", "is empty", "is not empty"],
  person: ["=", "!=", "in", "not in", "is empty", "is not empty"],
  date: ["=", "!=", ">", "<", ">=", "<=", "is empty", "is not empty"],
  datetime: ["=", "!=", ">", "<", ">=", "<=", "is empty", "is not empty"],
  number: ["=", "!=", ">", "<", ">=", "<=", "in", "not in", "is empty", "is not empty"],
  bool: ["=", "!="],
  text: ["=", "!=", "~", "in", "not in", "is empty", "is not empty"],
  fulltext: ["~"],
  custom: ["=", "!=", ">", "<", ">=", "<=", "in", "not in", "~", "is empty", "is not empty"],
};

/** Сравнение «больше/меньше» у приоритета и статуса категории имеет смысл — порядок шкалы. */
const ORDERED_ENUMS = new Set(["priority"]);

export function operatorsFor(field: TqlFieldInfo): readonly TqlOperator[] {
  if (field.kind === "enum" && ORDERED_ENUMS.has(field.name))
    return [...TQL_OPERATORS_BY_KIND.enum, ">", "<", ">=", "<="];
  return TQL_OPERATORS_BY_KIND[field.kind];
}

export interface TqlFunctionInfo {
  name: string;
  /** predicate — отдельное условие (branch(AOS-1)); value — значение справа от оператора (me()). */
  role: "predicate" | "value";
  args: ("key" | "number" | "linkType")[];
  /** Сколько аргументов обязательны (остальные — по желанию). */
  required: number;
  /** Какие поля принимают значение-функцию. */
  fits?: TqlFieldKind[];
  pending?: string;
}

export const TQL_FUNCTIONS: readonly TqlFunctionInfo[] = [
  { name: "me", role: "value", args: [], required: 0, fits: ["person"] },
  { name: "myTeams", role: "value", args: [], required: 0, fits: ["team"] },
  { name: "myGuilds", role: "value", args: [], required: 0, fits: ["guild"] },
  { name: "today", role: "value", args: [], required: 0, fits: ["date", "datetime"] },
  { name: "startOfWeek", role: "value", args: [], required: 0, fits: ["date", "datetime"] },
  { name: "daysAgo", role: "value", args: ["number"], required: 1, fits: ["date", "datetime"] },
  { name: "childrenOf", role: "predicate", args: ["key"], required: 1 },
  { name: "parentsOf", role: "predicate", args: ["key"], required: 1 },
  { name: "branch", role: "predicate", args: ["key"], required: 1 },
  { name: "linkedTo", role: "predicate", args: ["key", "linkType"], required: 1 },
  { name: "causedBy", role: "predicate", args: ["key"], required: 1 },
  { name: "parentTrace", role: "predicate", args: ["key"], required: 1 },
  { name: "overloaded", role: "predicate", args: [], required: 0, pending: "YT-19" },
];

const FUNCTION_BY_LOWER = new Map(TQL_FUNCTIONS.map((fn) => [fn.name.toLowerCase(), fn]));
export const tqlFunction = (name: string) => FUNCTION_BY_LOWER.get(name.toLowerCase()) ?? null;

/** Ключевые слова (без учёта регистра). */
export const TQL_KEYWORDS = ["and", "or", "not", "in", "is", "empty", "order", "by", "asc", "desc"] as const;

// ---- Ошибки: код, место и подсказка — интерфейс переводит по коду ----

export type TqlErrorCode =
  | "unexpected_end"
  | "unexpected_token"
  | "unterminated_string"
  | "bad_character"
  | "unquoted_text"
  | "unknown_field"
  | "unknown_function"
  | "expected_operator"
  | "expected_value"
  | "operator_not_allowed"
  | "function_not_allowed"
  | "wrong_arguments"
  | "empty_list"
  | "not_sortable"
  | "not_available"
  | "unknown_value";

export interface TqlProblem {
  code: TqlErrorCode;
  /** Место в тексте: [start, end). */
  start: number;
  end: number;
  /** Что встретилось (слово, символ). */
  found?: string;
  /** Что ожидалось или что подставить: «did you mean». */
  suggestion?: string;
  /** Для operator_not_allowed — допустимые операторы; для not_available — карточка. */
  detail?: string;
}

export class TqlError extends Error {
  override name = "TqlError";
  constructor(public readonly problem: TqlProblem) {
    super(`${problem.code} at ${problem.start}${problem.found ? `: ${problem.found}` : ""}`);
  }
}

// ---- Лексер ----

export type TqlTokenKind = "word" | "string" | "number" | "op" | "lparen" | "rparen" | "comma" | "end";

export interface TqlToken {
  kind: TqlTokenKind;
  text: string;
  start: number;
  end: number;
  /** Строка: значение без кавычек. */
  value?: string;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_.\-]/;
const NON_LATIN = /[\p{L}]/u;

export function tokenize(text: string, options: { partial?: boolean } = {}): TqlToken[] {
  const tokens: TqlToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const start = index;
    if (char === '"' || char === "'") {
      let value = "";
      index += 1;
      let closed = false;
      while (index < text.length) {
        const next = text[index] as string;
        if (next === "\\" && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
          continue;
        }
        if (next === char) {
          closed = true;
          index += 1;
          break;
        }
        value += next;
        index += 1;
      }
      if (!closed && !options.partial) {
        throw new TqlError({ code: "unterminated_string", start, end: text.length, found: text.slice(start) });
      }
      tokens.push({ kind: "string", text: text.slice(start, index), start, end: index, value });
      continue;
    }
    if (/[0-9]/.test(char)) {
      while (index < text.length && /[0-9.]/.test(text[index] as string)) index += 1;
      // «2026-11-20» — дата: читаем как слово.
      if (index < text.length && /[\-A-Za-z_]/.test(text[index] as string)) {
        while (index < text.length && WORD_PART.test(text[index] as string)) index += 1;
        tokens.push({ kind: "word", text: text.slice(start, index), start, end: index });
      } else tokens.push({ kind: "number", text: text.slice(start, index), start, end: index });
      continue;
    }
    if (WORD_START.test(char)) {
      while (index < text.length && WORD_PART.test(text[index] as string)) index += 1;
      // Хвост из кириллицы («teamЖабы») — это незакавыченное отображаемое имя.
      if (index < text.length && NON_LATIN.test(text[index] as string)) {
        let end = index;
        while (end < text.length && /[\p{L}\p{N}_\-]/u.test(text[end] as string)) end += 1;
        throw new TqlError({ code: "unquoted_text", start, end, found: text.slice(start, end) });
      }
      tokens.push({ kind: "word", text: text.slice(start, index), start, end: index });
      continue;
    }
    if (NON_LATIN.test(char)) {
      let end = index;
      while (end < text.length && /[\p{L}\p{N}_\-]/u.test(text[end] as string)) end += 1;
      if (options.partial) {
        tokens.push({ kind: "word", text: text.slice(start, end), start, end });
        index = end;
        continue;
      }
      throw new TqlError({
        code: "unquoted_text",
        start,
        end,
        found: text.slice(start, end),
        suggestion: `"${text.slice(start, end)}"`,
      });
    }
    const two = text.slice(index, index + 2);
    if (two === "!=" || two === ">=" || two === "<=") {
      tokens.push({ kind: "op", text: two, start, end: index + 2 });
      index += 2;
      continue;
    }
    if (char === "=" || char === ">" || char === "<" || char === "~") {
      tokens.push({ kind: "op", text: char, start, end: index + 1 });
      index += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === ",") {
      tokens.push({
        kind: char === "(" ? "lparen" : char === ")" ? "rparen" : "comma",
        text: char,
        start,
        end: index + 1,
      });
      index += 1;
      continue;
    }
    if (options.partial) {
      index += 1;
      continue;
    }
    throw new TqlError({ code: "bad_character", start, end: index + 1, found: char });
  }
  tokens.push({ kind: "end", text: "", start: text.length, end: text.length });
  return tokens;
}

const isKeyword = (token: TqlToken | undefined, word: string) =>
  token?.kind === "word" && token.text.toLowerCase() === word;

// ---- Подсказка «вы имели в виду» ----

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] as number;
      row[j] = Math.min((row[j] as number) + 1, (row[j - 1] as number) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] as number;
}

export function closest(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase();
  let best: string | undefined;
  let score = Infinity;
  for (const candidate of candidates) {
    const value = candidate.toLowerCase().startsWith(lower) ? 0.5 : distance(lower, candidate.toLowerCase());
    if (value < score) {
      score = value;
      best = candidate;
    }
  }
  return score <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

// ---- Разбор ----

export interface TqlParseOptions {
  /** Системные имена своих полей типов: без них неизвестное поле — ошибка с подсказкой. */
  customFields?: readonly string[];
}

export function parseTql(text: string, options: TqlParseOptions = {}): TqlQuery {
  const tokens = tokenize(text);
  let position = 0;
  const peek = (offset = 0) => tokens[position + offset] as TqlToken;
  const next = () => tokens[position++] as TqlToken;
  const custom = new Map((options.customFields ?? []).map((name) => [name.toLowerCase(), name]));
  const fieldNames = [...TQL_FIELDS.map((field) => field.name), ...custom.values()];

  const fail = (
    code: TqlErrorCode,
    token: TqlToken,
    extra: { [K in keyof TqlProblem]?: TqlProblem[K] | undefined } = {},
  ): never => {
    const defined = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined));
    throw new TqlError({
      code: token.kind === "end" && code === "unexpected_token" ? "unexpected_end" : code,
      start: token.start,
      end: Math.max(token.end, token.start + 1),
      ...(token.text ? { found: token.text } : {}),
      ...defined,
    });
  };

  function parseValue(): TqlValue {
    const token = peek();
    if (token.kind === "string") {
      next();
      return { kind: "string", text: token.value ?? "" };
    }
    if (token.kind === "number") {
      next();
      return { kind: "number", value: Number(token.text) };
    }
    if (token.kind === "word" && !TQL_KEYWORDS.includes(token.text.toLowerCase() as (typeof TQL_KEYWORDS)[number])) {
      next();
      if (peek().kind === "lparen") {
        const fn = tqlFunction(token.text);
        if (!fn) {
          return fail("unknown_function", token, {
            suggestion: closest(
              token.text,
              TQL_FUNCTIONS.filter((item) => item.role === "value").map((item) => item.name),
            ),
          });
        }
        if (fn.role !== "value") fail("function_not_allowed", token);
        const args = parseArgs(fn, token);
        return { kind: "call", name: fn.name, args };
      }
      return { kind: "word", text: token.text };
    }
    return fail("expected_value", token);
  }

  function parseArgs(fn: TqlFunctionInfo, at: TqlToken): TqlValue[] {
    next(); // (
    const args: TqlValue[] = [];
    if (peek().kind !== "rparen") {
      for (;;) {
        args.push(parseValue());
        if (peek().kind === "comma") {
          next();
          continue;
        }
        break;
      }
    }
    if (peek().kind !== "rparen") fail("unexpected_token", peek(), { suggestion: ")" });
    const close = next();
    if (args.length < fn.required || args.length > fn.args.length) {
      throw new TqlError({
        code: "wrong_arguments",
        start: at.start,
        end: close.end,
        found: fn.name,
        detail: `${fn.required}${fn.args.length > fn.required ? `-${fn.args.length}` : ""}`,
      });
    }
    return args;
  }

  function parsePrimary(): TqlExpr {
    const token = peek();
    if (token.kind === "lparen") {
      next();
      const item = parseOr();
      if (peek().kind !== "rparen") fail("unexpected_token", peek(), { suggestion: ")" });
      next();
      return { kind: "group", item };
    }
    if (isKeyword(token, "not")) {
      next();
      return { kind: "not", item: parsePrimary() };
    }
    if (token.kind !== "word") return fail("unexpected_token", token);
    next();
    // Функция-условие: branch(AOS-201).
    if (peek().kind === "lparen") {
      const fn = tqlFunction(token.text);
      if (!fn) {
        return fail("unknown_function", token, {
          suggestion: closest(
            token.text,
            TQL_FUNCTIONS.filter((item) => item.role === "predicate").map((item) => item.name),
          ),
        });
      }
      if (fn.role !== "predicate") fail("function_not_allowed", token);
      return { kind: "pred", name: fn.name, args: parseArgs(fn, token) };
    }
    // Условие: поле оператор значение.
    const info = tqlField(token.text) ?? (custom.has(token.text.toLowerCase()) ? null : undefined);
    const customName = custom.get(token.text.toLowerCase());
    if (info === undefined && !customName && options.customFields) {
      fail("unknown_field", token, { suggestion: closest(token.text, fieldNames) });
    }
    const field = info?.name ?? customName ?? token.text;
    const fieldInfo: TqlFieldInfo = info ?? { name: field, kind: "custom" };
    const opToken = peek();
    let op: TqlOperator;
    if (opToken.kind === "op") {
      next();
      op = opToken.text as TqlOperator;
    } else if (isKeyword(opToken, "in")) {
      next();
      op = "in";
    } else if (isKeyword(opToken, "not") && isKeyword(peek(1), "in")) {
      next();
      next();
      op = "not in";
    } else if (isKeyword(opToken, "is")) {
      next();
      if (isKeyword(peek(), "not")) {
        next();
        if (!isKeyword(peek(), "empty")) fail("unexpected_token", peek(), { suggestion: "empty" });
        next();
        op = "is not empty";
      } else {
        if (!isKeyword(peek(), "empty")) fail("unexpected_token", peek(), { suggestion: "empty" });
        next();
        op = "is empty";
      }
    } else {
      return fail("expected_operator", opToken, {
        suggestion: "=",
        ...(info === undefined && !customName ? { detail: field } : {}),
      });
    }
    const allowed = operatorsFor(fieldInfo);
    if (!allowed.includes(op)) {
      throw new TqlError({
        code: "operator_not_allowed",
        start: opToken.start,
        end: peek(-1).end,
        found: op,
        detail: allowed.join(" "),
        suggestion: field,
      });
    }
    if (op === "is empty" || op === "is not empty") return { kind: "cond", field, op };
    if (op === "in" || op === "not in") {
      if (peek().kind !== "lparen") fail("unexpected_token", peek(), { suggestion: "(" });
      const open = next();
      const values: TqlValue[] = [];
      if (peek().kind === "rparen") throw new TqlError({ code: "empty_list", start: open.start, end: peek().end });
      for (;;) {
        values.push(parseValue());
        if (peek().kind === "comma") {
          next();
          continue;
        }
        break;
      }
      if (peek().kind !== "rparen") fail("unexpected_token", peek(), { suggestion: ")" });
      next();
      return { kind: "cond", field, op, values };
    }
    return { kind: "cond", field, op, value: parseValue() };
  }

  function parseAnd(): TqlExpr {
    const items = [parsePrimary()];
    while (isKeyword(peek(), "and")) {
      next();
      items.push(parsePrimary());
    }
    return items.length === 1 ? (items[0] as TqlExpr) : { kind: "and", items };
  }

  function parseOr(): TqlExpr {
    const items = [parseAnd()];
    while (isKeyword(peek(), "or")) {
      next();
      items.push(parseAnd());
    }
    return items.length === 1 ? (items[0] as TqlExpr) : { kind: "or", items };
  }

  let where: TqlExpr | null = null;
  if (peek().kind !== "end" && !isKeyword(peek(), "order")) where = parseOr();
  const orderBy: TqlOrder[] = [];
  if (isKeyword(peek(), "order")) {
    next();
    if (!isKeyword(peek(), "by")) fail("unexpected_token", peek(), { suggestion: "by" });
    next();
    for (;;) {
      const token = peek();
      if (token.kind !== "word") fail("unexpected_token", token);
      next();
      const info = tqlField(token.text);
      const customName = custom.get(token.text.toLowerCase());
      if (!info && !customName && options.customFields) {
        fail("unknown_field", token, { suggestion: closest(token.text, fieldNames) });
      }
      if (info && !info.sortable) fail("not_sortable", token);
      let dir: "asc" | "desc" = "asc";
      if (isKeyword(peek(), "asc") || isKeyword(peek(), "desc")) dir = next().text.toLowerCase() as "asc" | "desc";
      orderBy.push({ field: info?.name ?? customName ?? token.text, dir });
      if (peek().kind === "comma") {
        next();
        continue;
      }
      break;
    }
  }
  if (peek().kind !== "end") {
    const token = peek();
    fail("unexpected_token", token, {
      suggestion: token.kind === "rparen" ? undefined : closest(token.text, ["and", "or", "order by"]),
    });
  }
  return { where, orderBy };
}

/** Разбор без исключения — для подсветки ошибок на лету. */
export function checkTql(
  text: string,
  options: TqlParseOptions = {},
): { ok: true; query: TqlQuery } | { ok: false; problem: TqlProblem } {
  try {
    return { ok: true, query: parseTql(text, options) };
  } catch (error) {
    if (error instanceof TqlError) return { ok: false, problem: error.problem };
    throw error;
  }
}

// ---- Канонический текст: чипы → текст → чипы без потерь ----

const BARE = /^[A-Za-z_][A-Za-z0-9_.\-]*$|^\d{4}-\d{2}-\d{2}$/;

export function printValue(value: TqlValue): string {
  switch (value.kind) {
    case "number":
      return String(value.value);
    case "word":
      return value.text;
    case "string":
      // Латинское имя без пробелов остаётся без кавычек только если его так и написали (word).
      return `"${value.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    case "call":
      return `${value.name}(${value.args.map(printValue).join(", ")})`;
  }
}

/** Значение, введённое в чип: латиница — системное имя (word), иначе строка в кавычках. */
export function valueFromInput(text: string): TqlValue {
  const trimmed = text.trim();
  const quoted = /^"(.*)"$/s.exec(trimmed) ?? /^'(.*)'$/s.exec(trimmed);
  if (quoted) return { kind: "string", text: (quoted[1] as string).replace(/\\(.)/g, "$1") };
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { kind: "number", value: Number(trimmed) };
  const call = /^([A-Za-z]+)\((.*)\)$/.exec(trimmed);
  if (call && tqlFunction(call[1] as string)?.role === "value") {
    const args = (call[2] as string)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map(valueFromInput);
    return { kind: "call", name: (tqlFunction(call[1] as string) as TqlFunctionInfo).name, args };
  }
  if (BARE.test(trimmed) && !TQL_KEYWORDS.includes(trimmed.toLowerCase() as (typeof TQL_KEYWORDS)[number])) {
    return { kind: "word", text: trimmed };
  }
  return { kind: "string", text: trimmed };
}

export function printExpr(expr: TqlExpr): string {
  switch (expr.kind) {
    case "cond":
      if (expr.op === "is empty" || expr.op === "is not empty") return `${expr.field} ${expr.op}`;
      if (expr.op === "in" || expr.op === "not in")
        return `${expr.field} ${expr.op} (${(expr.values ?? []).map(printValue).join(", ")})`;
      return `${expr.field} ${expr.op} ${expr.value ? printValue(expr.value) : ""}`.trimEnd();
    case "pred":
      return `${expr.name}(${expr.args.map(printValue).join(", ")})`;
    case "and":
    case "or":
      // Смешение and/or без скобок однозначно по приоритету, но вложенный or внутри and печатается в скобках.
      return expr.items
        .map((item) => (expr.kind === "and" && item.kind === "or" ? `(${printExpr(item)})` : printExpr(item)))
        .join(` ${expr.kind} `);
    case "not":
      return `not ${expr.item.kind === "and" || expr.item.kind === "or" ? `(${printExpr(expr.item)})` : printExpr(expr.item)}`;
    case "group":
      return `(${printExpr(expr.item)})`;
  }
}

export function printTql(query: TqlQuery): string {
  const where = query.where ? printExpr(query.where) : "";
  const order = query.orderBy.length
    ? `order by ${query.orderBy.map((item) => `${item.field} ${item.dir}`).join(", ")}`
    : "";
  return [where, order].filter(Boolean).join(" ");
}

/** Поля, упомянутые в запросе (архив скрыт, пока запрос не говорит об archived — R-2.11). */
export function tqlMentions(expr: TqlExpr | null, field: string): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "cond":
      return expr.field.toLowerCase() === field.toLowerCase();
    case "pred":
      return false;
    case "and":
    case "or":
      return expr.items.some((item) => tqlMentions(item, field));
    case "not":
    case "group":
      return tqlMentions(expr.item, field);
  }
}

/** Запрос из строки поиска: TQL, а простые слова без операторов — полнотекстовый поиск. */
export function searchToTql(input: string, options: TqlParseOptions = {}): TqlQuery {
  const text = input.trim();
  if (!text) return { where: null, orderBy: [] };
  const result = checkTql(text, options);
  if (result.ok) {
    // Одно слово без оператора разбирается как поле без оператора — это ошибка; ниже — текст.
    return result.query;
  }
  if (!/[=<>~()!"']/.test(text) && !/\b(and|or|order\s+by|is\s+(not\s+)?empty|in)\b/i.test(text)) {
    return { where: { kind: "cond", field: "text", op: "~", value: { kind: "string", text } }, orderBy: [] };
  }
  throw new TqlError(result.problem);
}

// ---- Автодополнение ----

export interface TqlCompletion {
  /** Что вставить. */
  insert: string;
  /** Что показать в списке (поле, оператор, значение, функция). */
  label: string;
  kind: "field" | "operator" | "value" | "function" | "keyword";
  /** Пояснение: тип поля, «появится с R-2.30» и т. п. */
  detail?: string;
}

export interface TqlCompletionContext {
  customFields?: readonly string[];
  /** Значения для поля: системное имя и отображаемое имя. */
  values?: (field: TqlFieldInfo) => { name: string; label: string }[];
}

/**
 * Подсказки на месте курсора: после начала, and/or/not и «(» — поля и функции-условия;
 * после поля — допустимые операторы; после оператора — значения и функции-значения; после условия — and/or/order by.
 * replaceFrom — откуда заменить недописанное слово.
 */
export function completeTql(
  text: string,
  cursor: number,
  context: TqlCompletionContext = {},
): { replaceFrom: number; items: TqlCompletion[] } {
  const before = text.slice(0, cursor);
  const tokens = tokenize(before, { partial: true }).filter((token) => token.kind !== "end");
  let partial = "";
  let replaceFrom = cursor;
  const last = tokens.at(-1);
  if (last && last.end === cursor && (last.kind === "word" || last.kind === "string")) {
    partial = last.kind === "string" ? (last.value ?? "") : last.text;
    replaceFrom = last.start;
    tokens.pop();
  }
  const lower = partial.toLowerCase();
  const match = (label: string) => !lower || label.toLowerCase().includes(lower);
  const prev = tokens.at(-1);
  const prev2 = tokens.at(-2);
  const fields = [
    ...TQL_FIELDS.map((field) => ({
      insert: field.name,
      label: field.name,
      kind: "field" as const,
      ...(field.pending ? { detail: field.pending } : {}),
    })),
    ...TQL_FIELDS.filter((field) => field.kind === "person" && !field.pending).flatMap((field) =>
      Object.keys(TQL_PERSON_PARTS).map((part) => ({
        insert: `${field.name}.${part}`,
        label: `${field.name}.${part}`,
        kind: "field" as const,
      })),
    ),
    ...(context.customFields ?? []).map((name) => ({
      insert: name,
      label: name,
      kind: "field" as const,
      detail: "custom",
    })),
    ...TQL_FUNCTIONS.filter((fn) => fn.role === "predicate").map((fn) => ({
      insert: `${fn.name}(`,
      label: `${fn.name}()`,
      kind: "function" as const,
      ...(fn.pending ? { detail: fn.pending } : {}),
    })),
    { insert: "not ", label: "not", kind: "keyword" as const },
  ];
  const startOfCondition = !prev || prev.kind === "lparen" || ["and", "or", "not"].includes(prev.text.toLowerCase());
  if (startOfCondition) return { replaceFrom, items: fields.filter((item) => match(item.label)) };

  // После «order by» и запятой в нём — сортируемые поля.
  const orderAt = tokens.findIndex((token, index) => isKeyword(token, "order") && isKeyword(tokens[index + 1], "by"));
  if (orderAt >= 0) {
    if (prev && (isKeyword(prev, "by") || prev.kind === "comma")) {
      return {
        replaceFrom,
        items: TQL_FIELDS.filter((field) => field.sortable && match(field.name)).map((field) => ({
          insert: field.name,
          label: field.name,
          kind: "field",
        })),
      };
    }
    if (prev?.kind === "word" && !isKeyword(prev, "asc") && !isKeyword(prev, "desc")) {
      return {
        replaceFrom,
        items: ["asc", "desc"].filter(match).map((word) => ({ insert: word, label: word, kind: "keyword" })),
      };
    }
    return { replaceFrom, items: [] };
  }

  // После поля — операторы.
  const fieldOf = (token: TqlToken | undefined) => {
    if (!token || token.kind !== "word") return null;
    return (
      tqlField(token.text) ??
      ((context.customFields ?? []).some((name) => name.toLowerCase() === token.text.toLowerCase())
        ? { name: token.text, kind: "custom" as const }
        : null)
    );
  };
  const field = fieldOf(prev);
  const startsCondition = (index: number) => {
    const before = tokens[index - 1];
    return !before || before.kind === "lparen" || ["and", "or", "not"].includes(before.text.toLowerCase());
  };
  if (field && startsCondition(tokens.length - 1)) {
    return {
      replaceFrom,
      items: operatorsFor(field)
        .filter((op) => match(op))
        .map((op) => ({ insert: `${op} `, label: op, kind: "operator" })),
    };
  }

  // После оператора (или внутри «in (»): значения поля и функции-значения.
  let opIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] as TqlToken;
    if (token.kind === "op" || isKeyword(token, "in")) {
      opIndex = index;
      break;
    }
    if (token.kind === "rparen" || isKeyword(token, "and") || isKeyword(token, "or")) break;
  }
  const insideList = prev?.kind === "lparen" || prev?.kind === "comma";
  const rightAfterOp = opIndex === tokens.length - 1 || (insideList && opIndex >= 0);
  if (opIndex >= 0 && rightAfterOp) {
    let fieldIndex = opIndex - 1;
    if (isKeyword(tokens[fieldIndex], "not")) fieldIndex -= 1;
    const target = fieldOf(tokens[fieldIndex]);
    if (target) {
      const values = (context.values?.(target) ?? []).filter((value) => match(value.name) || match(value.label));
      const functions = TQL_FUNCTIONS.filter(
        (fn) => fn.role === "value" && (fn.fits ?? []).includes(target.kind) && match(fn.name),
      );
      return {
        replaceFrom,
        items: [
          ...values.map((value) => ({
            insert: printValue(valueFromInput(value.name)),
            label: value.label === value.name ? value.name : `${value.label} · ${value.name}`,
            kind: "value" as const,
          })),
          ...functions.map((fn) => ({
            insert: `${fn.name}(${fn.args.length ? "" : ")"}`,
            label: `${fn.name}()`,
            kind: "function" as const,
          })),
        ],
      };
    }
  }

  // После законченного условия — логика и сортировка.
  if (prev && (prev.kind === "word" || prev.kind === "string" || prev.kind === "number" || prev.kind === "rparen")) {
    return {
      replaceFrom,
      items: ["and", "or", "order by"]
        .filter(match)
        .map((word) => ({ insert: `${word} `, label: word, kind: "keyword" })),
    };
  }
  void prev2;
  return { replaceFrom, items: [] };
}

// ---- Ответ поиска ----

export interface SearchResult<T> {
  items: T[];
  /** Сколько всего найдено среди тикетов, которые зритель видит (скрытые не считаются). */
  total: number;
  /** Канонический текст запроса. */
  query: string;
  /** Дерево запроса — для чипов. */
  tree: TqlQuery;
  /** Время исполнения на сервере, мс (R-3.4: ≤ 1000). */
  tookMs: number;
}

/** Сохранённый фильтр (R-2.28): личный или общий для пространства. */
export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  /** null — личный; id пространства — общий для всех, кто видит пространство. */
  spaceId: string | null;
  shared: boolean;
  owner: { id: string; name: string } | null;
  canEdit: boolean;
  updatedAt: string;
}

export interface SavedFilterInput {
  name: string;
  query: string;
  shared?: boolean;
  spaceId?: string | null;
}

/** Стартовое дерево зон R-5.1 (пока зоны не настраиваются, YT доски): зона → статусы по имени. */
export const STARTER_ZONES: readonly { key: string; name: string; parent: string | null; statuses: string[] }[] = [
  { key: "Discovery", name: "Discovery", parent: null, statuses: [] },
  { key: "Delivery", name: "Delivery", parent: null, statuses: [] },
  { key: "Done", name: "Done", parent: null, statuses: [] },
  { key: "Backlog", name: "Бэклог", parent: "Discovery", statuses: ["Backlog"] },
  { key: "DiscoveryWork", name: "Discovery", parent: "Discovery", statuses: ["Discovery", "Discovery Done"] },
  { key: "ToDo", name: "To Do", parent: "Delivery", statuses: ["To Do"] },
  {
    key: "Elaboration",
    name: "Проработка",
    parent: "Delivery",
    statuses: ["Analysis", "Analysis Done", "Design", "Design Done"],
  },
  {
    key: "Production",
    name: "Производство",
    parent: "Delivery",
    statuses: ["Creation", "Implementation", "In Progress", "Creation Done", "Implementation Done"],
  },
  { key: "Test", name: "Тест", parent: "Delivery", statuses: ["Test"] },
  { key: "Ready", name: "Готово", parent: "Done", statuses: ["Done"] },
];

/** Статусы зоны со всеми подзонами (зона «Delivery» — все статусы уровня 2 под ней). */
export function zoneStatuses(zoneKey: string): string[] {
  const own = STARTER_ZONES.filter((zone) => zone.key === zoneKey);
  const result = new Set<string>();
  for (const zone of own) {
    zone.statuses.forEach((status) => result.add(status));
    for (const child of STARTER_ZONES.filter((item) => item.parent === zone.key)) {
      zoneStatuses(child.key).forEach((status) => result.add(status));
    }
  }
  return [...result];
}

/** Словарь значений для чипов и автодополнения (GET /api/v1/search/vocabulary). */
export interface TqlVocabulary {
  customFields: { key: string; name: string; kind: string }[];
  values: Record<
    | "type"
    | "status"
    | "statusCategory"
    | "resolution"
    | "zone"
    | "space"
    | "team"
    | "guild"
    | "person"
    | "priority"
    | "bool"
    | "linkType",
    { name: string; label: string }[]
  >;
}

/** Какие значения подсказывать для поля. */
export function vocabularyFor(
  field: TqlFieldInfo,
  vocabulary: TqlVocabulary | undefined,
): { name: string; label: string }[] {
  if (!vocabulary) return [];
  const { values } = vocabulary;
  switch (field.kind) {
    case "team":
      return values.team;
    case "guild":
      return values.guild;
    case "person":
      return values.person;
    case "bool":
      return values.bool;
    case "enum":
      return (values as Record<string, { name: string; label: string }[]>)[field.name] ?? [];
    default:
      return [];
  }
}
