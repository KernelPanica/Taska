import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  PRIORITIES,
  STARTER_ZONES,
  TqlError,
  printTql,
  searchToTql,
  tqlField,
  tqlFunction,
  tqlMentions,
  zoneStatuses,
  type SavedFilter,
  type SavedFilterInput,
  type SearchResult,
  type TicketSummary,
  type TqlExpr,
  type TqlFieldInfo,
  type TqlOrder,
  type TqlProblem,
  type TqlQuery,
  type TqlValue,
  type TqlVocabulary,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, type UserRow } from "../auth/sessions.js";
import type { TicketAccess, ViewerContext } from "../access/service.js";
import { createdAsTest, visibleSql } from "../directory/common.js";
import { requireVisibleSpace } from "../spaces/routes.js";
import { placeholders } from "../ticket-types/common.js";
import { ticketService, type TicketRow, type TicketService } from "./service.js";

/**
 * Исполнение TQL (R-2.28, R-5.3; YT-15, docs/adr/0021). Разбирает запрос общий разборщик из contracts;
 * здесь дерево превращается в SQL по таблице тикетов, затем результат проходит через права зрителя (R-2.20):
 * скрытые не попадают ни в выдачу, ни в счётчик. «Только заголовок» по условиям не ищется — иначе запрос
 * раскрывал бы скрытое содержимое; поле под маской — тоже.
 */
type Sql = { sql: string; params: unknown[] };
const sql = (text: string, ...params: unknown[]): Sql => ({ sql: text, params });
const join = (parts: Sql[], glue: string): Sql => ({
  sql: parts.map((part) => `(${part.sql})`).join(glue),
  params: parts.flatMap((part) => part.params),
});
const NONE = sql("0");

/** Приоритет: шкала и синонимы (R-5.3 «priority = Urgent»; русские подписи). */
const PRIORITY_ALIASES: Record<string, (typeof PRIORITIES)[number]> = {
  urgent: "highest",
  critical: "highest",
  наивысший: "highest",
  срочный: "highest",
  высокий: "high",
  обычный: "normal",
  medium: "normal",
  низкий: "low",
  "самый низкий": "lowest",
};
const PRIORITY_RANK = `CASE t.priority WHEN 'lowest' THEN 1 WHEN 'low' THEN 2 WHEN 'normal' THEN 3 WHEN 'high' THEN 4 ELSE 5 END`;
const CATEGORY_ALIASES: Record<string, string> = {
  queue: "queue",
  active: "in_progress",
  in_progress: "in_progress",
  inprogress: "in_progress",
  done: "done",
  очередь: "queue",
  "в работе": "in_progress",
  завершён: "done",
};

const normalize = (text: string) => text.toLocaleLowerCase("ru").replace(/ё/g, "е");
const DAY = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface CustomField {
  id: string;
  key: string;
  kind: string;
  scale_id: string | null;
  dimension_id: string | null;
}

const registered = new WeakSet<Database>();

export function tqlService(db: Database, tickets: TicketService) {
  const { access } = tickets;
  if (!registered.has(db)) {
    // Подстрока без учёта регистра для кириллицы («~» по legacyNumber и своим текстовым полям).
    db.function("tql_contains", { deterministic: true }, (haystack: unknown, needle: unknown) =>
      haystack === null || needle === null
        ? 0
        : normalize(String(haystack)).includes(normalize(String(needle)))
          ? 1
          : 0,
    );
    registered.add(db);
  }

  const customFields = () =>
    db.prepare("SELECT id, key, kind, scale_id, dimension_id FROM ticket_fields").all() as CustomField[];

  const problem = (code: TqlProblem["code"], found: string, extra: Partial<TqlProblem> = {}) =>
    new TqlError({ code, start: 0, end: 0, found, ...extra });

  /** Компилятор одного запроса: зритель нужен для me(), myTeams(), myGuilds() и тестовых данных. */
  function compiler(viewer: UserRow) {
    const fields = new Map(customFields().map((field) => [field.key.toLowerCase(), field]));
    const usedCustom = new Set<string>();

    const text = (value: TqlValue): string => {
      if (value.kind === "word" || value.kind === "string") return value.text;
      if (value.kind === "number") return String(value.value);
      return value.name;
    };

    /** Дата значения: «2026-11-20», today(), startOfWeek(), daysAgo(n). */
    function date(value: TqlValue): string {
      if (value.kind === "call") {
        const now = Date.now();
        if (value.name === "today") return isoDay(now);
        if (value.name === "daysAgo") {
          const days = value.args[0]?.kind === "number" ? value.args[0].value : Number(text(value.args[0] as TqlValue));
          return isoDay(now - days * DAY);
        }
        if (value.name === "startOfWeek") {
          const day = new Date(isoDay(now));
          const shift = (day.getUTCDay() + 6) % 7;
          return isoDay(day.getTime() - shift * DAY);
        }
        throw problem("function_not_allowed", `${value.name}()`);
      }
      const raw = text(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw problem("unknown_value", raw, { detail: "date YYYY-MM-DD" });
      return raw;
    }

    const ticketByKey = (value: TqlValue) => {
      const key = text(value).toUpperCase();
      const row = db
        .prepare(`SELECT id, key FROM tickets WHERE key = ? AND ${visibleSql(viewer, "is_test")}`)
        .get(key) as { id: string } | undefined;
      if (!row) throw problem("unknown_value", key, { detail: "key" });
      return row.id;
    };

    /** Значения справочного поля: системное имя латиницей или отображаемое имя (R-5.3). */
    function ids(table: "teams" | "guilds" | "people" | "types" | "spaces", values: TqlValue[]): string[] {
      const result = new Set<string>();
      for (const value of values) {
        if (value.kind === "call") {
          const fn = tqlFunction(value.name);
          if (value.name === "me" && table === "people") result.add(viewer.id);
          else if (value.name === "myTeams" && table === "teams")
            (
              db.prepare("SELECT team_id AS id FROM feature_team_members WHERE user_id = ?").all(viewer.id) as {
                id: string;
              }[]
            ).forEach((row) => result.add(row.id));
          else if (value.name === "myGuilds" && table === "guilds")
            (
              db.prepare("SELECT guild_id AS id FROM guild_members WHERE user_id = ?").all(viewer.id) as {
                id: string;
              }[]
            ).forEach((row) => result.add(row.id));
          else throw problem("function_not_allowed", `${fn?.name ?? value.name}()`);
          continue;
        }
        const raw = text(value);
        const query = {
          teams: `SELECT id FROM feature_teams WHERE (id = ? OR lower(key) = lower(?) OR lower(name) = lower(?)) AND ${visibleSql(viewer)}`,
          guilds: `SELECT id FROM guilds WHERE (id = ? OR lower(key) = lower(?) OR lower(name) = lower(?)) AND ${visibleSql(viewer)}`,
          people: `SELECT u.id FROM users u LEFT JOIN catalog_profiles c ON c.user_id = u.id
                   WHERE (u.id = ? OR lower(c.username) = lower(?) OR lower(u.email) = lower(?) OR lower(u.name) = lower(?))`,
          types: "SELECT id FROM ticket_types WHERE id = ? OR lower(key) = lower(?) OR lower(name) = lower(?)",
          spaces: `SELECT id FROM spaces WHERE (id = ? OR lower(slug) = lower(?) OR lower(name) = lower(?)) AND ${visibleSql(viewer)}`,
        }[table];
        const args = table === "people" ? [raw, raw, raw, raw] : [raw, raw, raw];
        let rows = db.prepare(query).all(...args) as { id: string }[];
        // Кириллица в нижнем регистре SQLite не сравнивается — дополнительная проверка в JS.
        if (!rows.length && table !== "people") {
          const all = db
            .prepare(
              {
                teams: "SELECT id, name FROM feature_teams",
                guilds: "SELECT id, name FROM guilds",
                types: "SELECT id, name FROM ticket_types",
                spaces: "SELECT id, name FROM spaces",
              }[table],
            )
            .all() as { id: string; name: string }[];
          rows = all.filter((row) => normalize(row.name) === normalize(raw));
        }
        if (!rows.length && table === "people") {
          rows = (db.prepare("SELECT id, name FROM users").all() as { id: string; name: string }[]).filter(
            (row) => normalize(row.name) === normalize(raw),
          );
        }
        if (!rows.length) throw problem("unknown_value", raw, { detail: table });
        rows.forEach((row) => result.add(row.id));
      }
      return [...result];
    }

    const inList = (column: string, list: readonly unknown[]): Sql =>
      list.length ? sql(`${column} IN (${placeholders(list)})`, ...list) : NONE;

    /** Поле с несколькими значениями через json_each: «=» значит «среди значений есть». */
    const jsonHas = (path: string, list: readonly unknown[]): Sql =>
      list.length
        ? sql(
            `EXISTS (SELECT 1 FROM json_each(t.field_values, '${path}') j WHERE j.value IN (${placeholders(list)}))`,
            ...list,
          )
        : NONE;
    const jsonEmpty = (path: string) =>
      sql(
        `NOT EXISTS (SELECT 1 FROM json_each(t.field_values, '${path}') j WHERE j.value IS NOT NULL AND j.value <> '')`,
      );

    const people = (role: string, list: readonly string[]): Sql =>
      role === "reporter"
        ? inList("t.created_by", list)
        : list.length
          ? sql(
              `EXISTS (SELECT 1 FROM ticket_people p WHERE p.ticket_id = t.id AND p.role = ? AND p.user_id IN (${placeholders(list)}))`,
              role,
              ...list,
            )
          : NONE;
    const peopleEmpty = (role: string): Sql =>
      role === "reporter"
        ? sql("t.created_by IS NULL")
        : sql("NOT EXISTS (SELECT 1 FROM ticket_people p WHERE p.ticket_id = t.id AND p.role = ?)", role);
    const ROLE: Record<string, string> = {
      assignee: "assignee",
      watcher: "watcher",
      tester: "tester",
      reporter: "reporter",
    };

    /** Сравнение: «=», «in» — набор; «!=», «not in» — его отрицание; «is empty». */
    function membership(op: string, has: () => Sql, empty: () => Sql): Sql {
      if (op === "=" || op === "in") return has();
      if (op === "!=" || op === "not in") return sql(`NOT (${has().sql})`, ...has().params);
      if (op === "is empty") return empty();
      if (op === "is not empty") return sql(`NOT (${empty().sql})`, ...empty().params);
      throw problem("operator_not_allowed", op);
    }

    const compare = (column: string, op: string, value: unknown): Sql => {
      const sqlOp = op === "!=" ? "<>" : op;
      if (op === "is empty") return sql(`${column} IS NULL OR ${column} = ''`);
      if (op === "is not empty") return sql(`${column} IS NOT NULL AND ${column} <> ''`);
      return sql(`${column} ${sqlOp} ?`, value);
    };

    /** Даты: дни сравниваются как «YYYY-MM-DD», моменты (created) — по дню UTC. */
    function dateCond(column: string, op: string, value: TqlValue | undefined, moment: boolean): Sql {
      const day = moment ? `date(${column} / 1000, 'unixepoch')` : column;
      if (op === "is empty") return sql(`${column} IS NULL OR ${column} = ''`);
      if (op === "is not empty") return sql(`${column} IS NOT NULL AND ${column} <> ''`);
      return sql(`${day} ${op === "!=" ? "<>" : op} ?`, date(value as TqlValue));
    }

    const ACTUAL = (category: "in_progress" | "done", fn: "min" | "max") =>
      `(SELECT ${fn}(h.at) FROM ticket_history h JOIN scheme_statuses s ON s.id = json_extract(h.to_value, '$.raw')
         WHERE h.ticket_id = t.id AND h.field = 'status' AND s.category = '${category}')`;
    const DUE_SHIFTS = `(SELECT count(*) FROM ticket_history h WHERE h.ticket_id = t.id
         AND h.field IN ('endDate', 'values.due_date') AND h.from_value IS NOT NULL AND h.to_value IS NOT NULL)`;
    const DUE = `coalesce(json_extract(t.field_values, '$.due_date'), t.end_date)`;

    /** Своё поле типа по системному имени: варианты списка, люди, шкалы — по подписи или id. */
    function customCond(name: string, op: string, value: TqlValue | undefined, values: TqlValue[] | undefined): Sql {
      const field = fields.get(name.toLowerCase());
      const key = field?.key ?? name;
      if (!/^[A-Za-z0-9_]+$/.test(key)) throw problem("unknown_field", name);
      usedCustom.add(key);
      const path = `$.${key}`;
      const list = values ?? (value ? [value] : []);
      const resolve = (item: TqlValue): unknown[] => {
        if (!field) return [item.kind === "number" ? item.value : text(item)];
        const raw = text(item);
        const lookup = (query: string, ...params: unknown[]) => {
          const rows = (db.prepare(query).all(...params) as { id: string; label: string }[]).filter(
            (row) => row.id === raw || normalize(row.label) === normalize(raw),
          );
          if (!rows.length) throw problem("unknown_value", raw, { detail: field.key });
          return rows.map((row) => row.id);
        };
        switch (field.kind) {
          case "list":
            return lookup("SELECT id, label FROM ticket_field_options WHERE field_id = ?", field.id);
          case "person":
            return ids("people", [item]);
          case "estimate": {
            const scale = db.prepare("SELECT kind FROM estimate_scales WHERE id = ?").get(field.scale_id) as
              | { kind: string }
              | undefined;
            if (scale?.kind === "numeric") return [item.kind === "number" ? item.value : Number(raw)];
            return lookup("SELECT id, label FROM estimate_scale_values WHERE scale_id = ?", field.scale_id);
          }
          case "dimension": {
            const dimension = db.prepare("SELECT kind, source FROM dimensions WHERE id = ?").get(field.dimension_id) as
              | { kind: string; source: string | null }
              | undefined;
            if (dimension?.kind === "list")
              return lookup("SELECT id, label FROM dimension_options WHERE dimension_id = ?", field.dimension_id);
            return ids(dimension?.source === "guilds" ? "guilds" : "teams", [item]);
          }
          case "number":
            return [item.kind === "number" ? item.value : Number(raw)];
          case "date":
            return [date(item)];
          default:
            return [raw];
        }
      };
      if (op === "is empty") return jsonEmpty(path);
      if (op === "is not empty") return sql(`NOT (${jsonEmpty(path).sql})`);
      if (op === "~") {
        return sql(
          `EXISTS (SELECT 1 FROM json_each(t.field_values, '${path}') j WHERE tql_contains(j.value, ?))`,
          text(value as TqlValue),
        );
      }
      if (op === "=" || op === "in" || op === "!=" || op === "not in") {
        const all = list.flatMap(resolve);
        return membership(
          op,
          () => jsonHas(path, all),
          () => jsonEmpty(path),
        );
      }
      const [first] = resolve(value as TqlValue);
      return sql(`EXISTS (SELECT 1 FROM json_each(t.field_values, '${path}') j WHERE j.value ${op} ?)`, first);
    }

    function cond(expr: Extract<TqlExpr, { kind: "cond" }>): Sql {
      const { op, value } = expr;
      const values = expr.values ?? (value ? [value] : []);
      const info: TqlFieldInfo = tqlField(expr.field) ?? { name: expr.field, kind: "custom" };
      const [base, part] = info.name.split(".");
      if (part) {
        // assignee.guild = GD: исполнитель состоит в колодце (команде).
        const role = ROLE[base as string] ?? null;
        const table = part === "guild" ? "guild_members" : "feature_team_members";
        const column = part === "guild" ? "guild_id" : "team_id";
        const groupIds = () => ids(part === "guild" ? "guilds" : "teams", values);
        const personColumn = role === "reporter" ? "t.created_by" : "p.user_id";
        const from =
          role === "reporter"
            ? `FROM ${table} m WHERE m.user_id = t.created_by`
            : `FROM ticket_people p JOIN ${table} m ON m.user_id = p.user_id WHERE p.ticket_id = t.id AND p.role = '${role}'`;
        void personColumn;
        if (!role)
          return membership(
            op,
            () => NONE,
            () => sql("1"),
          );
        return membership(
          op,
          () => {
            const list = groupIds();
            return list.length
              ? sql(`EXISTS (SELECT 1 ${from} AND m.${column} IN (${placeholders(list)}))`, ...list)
              : NONE;
          },
          () => sql(`NOT EXISTS (SELECT 1 ${from})`),
        );
      }
      switch (info.name) {
        case "key": {
          if (op === "=" || op === "in" || op === "!=" || op === "not in") {
            const keys = values.map((item) => text(item).toUpperCase());
            return membership(
              op,
              () => inList("t.key", keys),
              () => NONE,
            );
          }
          const number = Number(
            text(value as TqlValue)
              .split("-")
              .pop(),
          );
          return sql(`t.number ${op} ?`, number);
        }
        case "type":
          return membership(
            op,
            () => inList("t.type_id", ids("types", values)),
            () => NONE,
          );
        case "space":
          return membership(
            op,
            () => inList("t.space_id", ids("spaces", values)),
            () => NONE,
          );
        case "status": {
          const names = values.map(text);
          const statusIds = () => {
            const rows = (
              db.prepare("SELECT id, name FROM scheme_statuses").all() as { id: string; name: string }[]
            ).filter((row) => names.some((name) => normalize(name) === normalize(row.name) || name === row.id));
            if (!rows.length) throw problem("unknown_value", names.join(", "), { detail: "status" });
            return rows.map((row) => row.id);
          };
          return membership(
            op,
            () => inList("t.status_id", statusIds()),
            () => NONE,
          );
        }
        case "statusCategory": {
          const categories = values.map((item) => {
            const found = CATEGORY_ALIASES[normalize(text(item)).replace(/\s+/g, " ")];
            if (!found) throw problem("unknown_value", text(item), { detail: "queue, active, done" });
            return found;
          });
          return membership(
            op,
            () => inList("(SELECT s.category FROM scheme_statuses s WHERE s.id = t.status_id)", categories),
            () => NONE,
          );
        }
        case "resolution": {
          const outcomes = values.map((item) => {
            const raw = text(item);
            const types = db.prepare("SELECT outcomes FROM ticket_types").all() as { outcomes: string }[];
            const label = types
              .flatMap((row) => JSON.parse(row.outcomes) as { key: string; label: string }[])
              .find(
                (outcome) =>
                  normalize(outcome.label) === normalize(raw) || outcome.key.toLowerCase() === raw.toLowerCase(),
              );
            if (!label) throw problem("unknown_value", raw, { detail: "resolution" });
            return label.key;
          });
          return membership(
            op,
            () => inList("t.outcome", outcomes),
            () => sql("t.outcome IS NULL"),
          );
        }
        case "zone": {
          // Стартовое дерево зон R-5.1 по имени статуса: зона включает свои подзоны.
          const statusNames = values.flatMap((item) => {
            const raw = normalize(text(item));
            const zones = STARTER_ZONES.filter((zone) => normalize(zone.key) === raw || normalize(zone.name) === raw);
            if (!zones.length)
              throw problem("unknown_value", text(item), { detail: STARTER_ZONES.map((zone) => zone.key).join(", ") });
            return zones.flatMap((zone) => zoneStatuses(zone.key));
          });
          return membership(
            op,
            () => inList("(SELECT s.name FROM scheme_statuses s WHERE s.id = t.status_id)", statusNames),
            () => NONE,
          );
        }
        case "team":
          return membership(
            op,
            () => jsonHas("$.team", ids("teams", values)),
            () => jsonEmpty("$.team"),
          );
        case "stream":
          return membership(
            op,
            () => jsonHas("$.stream", ids("guilds", values)),
            () => jsonEmpty("$.stream"),
          );
        case "involvedTeams": {
          // Команды детей плюс добавленные вручную (R-2.29).
          const has = () => {
            const list = ids("teams", values);
            if (!list.length) return NONE;
            return sql(
              `EXISTS (SELECT 1 FROM ticket_parents p JOIN tickets c ON c.id = p.child_id
                 WHERE p.parent_id = t.id AND c.deleted_at IS NULL AND json_extract(c.field_values, '$.team') IN (${placeholders(list)}))
               OR EXISTS (SELECT 1 FROM json_each(t.field_values, '$.involvedTeams') j WHERE j.value IN (${placeholders(list)}))`,
              ...list,
              ...list,
            );
          };
          return membership(op, has, () =>
            sql(
              `NOT EXISTS (SELECT 1 FROM ticket_parents p JOIN tickets c ON c.id = p.child_id
                 WHERE p.parent_id = t.id AND json_extract(c.field_values, '$.team') IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM json_each(t.field_values, '$.involvedTeams'))`,
            ),
          );
        }
        case "assignee":
        case "watcher":
        case "tester":
        case "reporter":
          return membership(
            op,
            () => people(ROLE[info.name] as string, ids("people", values)),
            () => peopleEmpty(ROLE[info.name] as string),
          );
        case "priority": {
          const rank = (item: TqlValue) => {
            const raw = normalize(text(item));
            const key = (PRIORITIES as readonly string[]).includes(raw) ? raw : PRIORITY_ALIASES[raw];
            if (!key) throw problem("unknown_value", text(item), { detail: PRIORITIES.join(", ") });
            return key;
          };
          if (op === "=" || op === "in" || op === "!=" || op === "not in")
            return membership(
              op,
              () => inList("t.priority", values.map(rank)),
              () => NONE,
            );
          if (op === "is empty") return NONE;
          if (op === "is not empty") return sql("1");
          const ranks = ["lowest", "low", "normal", "high", "highest"];
          return sql(`${PRIORITY_RANK} ${op} ?`, ranks.indexOf(rank(value as TqlValue)) + 1);
        }
        case "start":
          return dateCond("t.start_date", op, value, false);
        case "due":
          return dateCond(DUE, op, value, false);
        case "created":
          return dateCond("t.created_at", op, value, true);
        case "updated":
          return dateCond("t.updated_at", op, value, true);
        case "actualStart":
          return dateCond(ACTUAL("in_progress", "min"), op, value, true);
        case "actualEnd":
          return dateCond(
            `CASE WHEN (SELECT s.category FROM scheme_statuses s WHERE s.id = t.status_id) = 'done' THEN ${ACTUAL("done", "max")} END`,
            op,
            value,
            true,
          );
        case "dueShifts":
          if (op === "in" || op === "not in") {
            const list = values.map((item) => Number(text(item)));
            return membership(
              op,
              () => inList(DUE_SHIFTS, list),
              () => NONE,
            );
          }
          return compare(DUE_SHIFTS, op, Number(text(value as TqlValue)));
        case "archived": {
          const raw = normalize(text(value as TqlValue));
          if (!["true", "false", "yes", "no", "да", "нет"].includes(raw))
            throw problem("unknown_value", raw, { detail: "true, false" });
          const yes = ["true", "yes", "да"].includes(raw) !== (op === "!=");
          return sql(yes ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL");
        }
        case "legacyNumber":
          if (op === "~") return sql("tql_contains(t.legacy_number, ?)", text(value as TqlValue));
          if (op === "in" || op === "not in" || op === "=" || op === "!=")
            return membership(
              op,
              () => inList("t.legacy_number", values.map(text)),
              () => sql("t.legacy_number IS NULL"),
            );
          return compare("t.legacy_number", op, text(value as TqlValue));
        case "text": {
          // Полнотекст: ключ, название, описание, старый номер и комментарии (R-2.28). Триграммы — от трёх букв.
          const needle = normalize(text(value as TqlValue)).trim();
          if (!needle) return sql("1");
          if ([...needle].length < 3)
            return sql("tql_contains(t.key || ' ' || t.title || ' ' || coalesce(t.legacy_number, ''), ?)", needle);
          const phrase = `"${needle.replace(/"/g, '""')}"`;
          return sql(
            `t.rowid IN (SELECT rowid FROM ticket_text WHERE ticket_text MATCH ?)
             OR t.id IN (SELECT ticket_id FROM comment_text WHERE comment_text MATCH ?)`,
            phrase,
            phrase,
          );
        }
        case "estimate":
          return customCond("size", op, value, expr.values);
        default:
          // Поля других карточек (owner, rework…) и свои поля типа — по системному имени в значениях.
          if (info.kind === "bool") {
            const raw = normalize(text(value as TqlValue));
            const yes = ["true", "yes", "да"].includes(raw) !== (op === "!=");
            return sql(
              yes
                ? `json_extract(t.field_values, '$.${info.name}') IN (1, 'true')`
                : `coalesce(json_extract(t.field_values, '$.${info.name}'), 0) NOT IN (1, 'true')`,
            );
          }
          return customCond(info.name, op, value, expr.values);
      }
    }

    function pred(expr: Extract<TqlExpr, { kind: "pred" }>): Sql {
      const [first, second] = expr.args;
      switch (expr.name) {
        case "childrenOf":
          return sql(
            "t.id IN (SELECT child_id FROM ticket_parents WHERE parent_id = ?)",
            ticketByKey(first as TqlValue),
          );
        case "parentsOf":
          return sql(
            "t.id IN (SELECT parent_id FROM ticket_parents WHERE child_id = ?)",
            ticketByKey(first as TqlValue),
          );
        case "branch":
          return sql(
            "t.id IN (SELECT descendant_id FROM ticket_closure WHERE ancestor_id = ?)",
            ticketByKey(first as TqlValue),
          );
        case "causedBy":
          return sql(
            `t.id IN (SELECT l.to_id FROM ticket_links l JOIN link_types ty ON ty.id = l.type_id
               WHERE ty.key = 'causes' AND l.from_id = ?)`,
            ticketByKey(first as TqlValue),
          );
        case "linkedTo": {
          const id = ticketByKey(first as TqlValue);
          if (!second) {
            return sql(
              "t.id IN (SELECT to_id FROM ticket_links WHERE from_id = ? UNION SELECT from_id FROM ticket_links WHERE to_id = ?)",
              id,
              id,
            );
          }
          const raw = text(second);
          const types = (
            db.prepare("SELECT id, key, name, inverse_name FROM link_types").all() as {
              id: string;
              key: string;
              name: string;
              inverse_name: string;
            }[]
          ).filter(
            (row) =>
              row.id === raw ||
              row.key.toLowerCase() === raw.toLowerCase() ||
              normalize(row.name) === normalize(raw) ||
              normalize(row.inverse_name) === normalize(raw),
          );
          if (!types.length) throw problem("unknown_value", raw, { detail: "link type" });
          const list = types.map((row) => row.id);
          return sql(
            `t.id IN (SELECT to_id FROM ticket_links WHERE from_id = ? AND type_id IN (${placeholders(list)})
              UNION SELECT from_id FROM ticket_links WHERE to_id = ? AND type_id IN (${placeholders(list)}))`,
            id,
            ...list,
            id,
            ...list,
          );
        }
        case "parentTrace":
          return sql(
            "t.id IN (SELECT child_id FROM parent_traces WHERE parent_key = ?)",
            text(first as TqlValue).toUpperCase(),
          );
        default: {
          const fn = tqlFunction(expr.name);
          throw problem(
            fn?.pending ? "not_available" : "unknown_function",
            `${expr.name}()`,
            fn?.pending ? { detail: fn.pending } : {},
          );
        }
      }
    }

    function where(expr: TqlExpr): Sql {
      switch (expr.kind) {
        case "cond":
          return cond(expr);
        case "pred":
          return pred(expr);
        case "and":
          return join(expr.items.map(where), " AND ");
        case "or":
          return join(expr.items.map(where), " OR ");
        case "not": {
          const inner = where(expr.item);
          return sql(`NOT (${inner.sql})`, ...inner.params);
        }
        case "group":
          return where(expr.item);
      }
    }

    function order(items: readonly TqlOrder[]): string {
      if (!items.length) return "t.number DESC";
      const column = (field: string) => {
        switch (field) {
          case "key":
            return "t.number";
          case "created":
            return "t.created_at";
          case "updated":
            return "t.updated_at";
          case "due":
            return DUE;
          case "start":
            return "t.start_date";
          case "priority":
            return PRIORITY_RANK;
          case "status":
            return "(SELECT s.name FROM scheme_statuses s WHERE s.id = t.status_id)";
          case "statusCategory":
            return "(SELECT CASE s.category WHEN 'queue' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END FROM scheme_statuses s WHERE s.id = t.status_id)";
          case "type":
            return "(SELECT ty.name FROM ticket_types ty WHERE ty.id = t.type_id)";
          case "space":
            return "(SELECT sp.name FROM spaces sp WHERE sp.id = t.space_id)";
          case "team":
            return "(SELECT ft.name FROM feature_teams ft WHERE ft.id = json_extract(t.field_values, '$.team'))";
          case "legacyNumber":
            return "t.legacy_number";
          case "dueShifts":
            return DUE_SHIFTS;
          case "actualStart":
            return ACTUAL("in_progress", "min");
          case "actualEnd":
            return ACTUAL("done", "max");
          default: {
            const key = fields.get(field.toLowerCase())?.key ?? field;
            if (!/^[A-Za-z0-9_]+$/.test(key)) throw problem("not_sortable", field);
            usedCustom.add(key);
            return `json_extract(t.field_values, '$.${key}')`;
          }
        }
      };
      // Пустые значения — в конце при любом направлении.
      return [
        ...items.map((item) => `${column(item.field)} IS NULL, ${column(item.field)} ${item.dir.toUpperCase()}`),
        "t.number DESC",
      ].join(", ");
    }

    return { where, order, usedCustom, customNames: () => [...fields.values()].map((field) => field.key) };
  }

  /** Разбор строки поиска с нашими своими полями; ошибка — 400 tql_invalid с местом и подсказкой. */
  function parse(input: string): TqlQuery {
    try {
      return searchToTql(input, { customFields: customFields().map((field) => field.key) });
    } catch (error) {
      if (error instanceof TqlError) throw invalid(error.problem);
      throw error;
    }
  }

  const invalid = (problemDetail: TqlProblem) =>
    new AppError(400, "tql_invalid", `The query has an error: ${problemDetail.code}`, undefined, {
      tql: problemDetail,
    });

  /**
   * Тикеты, подходящие под запрос и видимые зрителю (R-2.20), в порядке запроса.
   * С условием «только заголовок» не находится, поле под маской — тоже.
   */
  function match(
    viewer: UserRow,
    query: TqlQuery,
    options: {
      spaceId?: string | undefined;
      archived?: "exclude" | "include" | "only" | undefined;
      ctx?: ViewerContext;
    },
  ): { ids: string[]; accs: Map<string, TicketAccess> } {
    const compile = compiler(viewer);
    let condition: Sql;
    let orderSql: string;
    try {
      condition = query.where ? compile.where(query.where) : sql("1");
      orderSql = compile.order(query.orderBy);
    } catch (error) {
      if (error instanceof TqlError) throw invalid(error.problem);
      throw error;
    }
    // Архив скрыт, пока запрос не говорит об archived (R-2.11).
    const archived = tqlMentions(query.where, "archived")
      ? "1 = 1"
      : options.archived === "only"
        ? "t.archived_at IS NOT NULL"
        : options.archived === "include"
          ? "1 = 1"
          : "t.archived_at IS NULL";
    const space = options.spaceId ? requireVisibleSpace(db, viewer, options.spaceId).id : null;
    const rows = db
      .prepare(
        `SELECT t.id FROM tickets t WHERE t.deleted_at IS NULL AND ${archived} AND ${visibleSql(viewer, "t.is_test")}
           ${space ? "AND t.space_id = ?" : ""} AND (${condition.sql}) ORDER BY ${orderSql}`,
      )
      .all(...(space ? [space] : []), ...condition.params) as { id: string }[];
    const ctx = options.ctx ?? access.context(viewer);
    const accs = access.evaluateMany(
      viewer,
      rows.map((row) => row.id),
      ctx,
    );
    const filtered = query.where !== null;
    const maskCache = new Map<string, boolean>();
    const masked = (acc: TicketAccess) => {
      if (!compile.usedCustom.size) return false;
      const key = [...acc.profiles].sort().join(",");
      let hit = maskCache.get(key);
      if (hit === undefined) {
        const hidden = access.maskedFields(acc.profiles);
        hit = [...compile.usedCustom].some((field) => hidden.has(field));
        maskCache.set(key, hit);
      }
      return hit;
    };
    const ids = rows
      .map((row) => row.id)
      .filter((id) => {
        const acc = accs.get(id);
        if (!acc || acc.level === "none") return false;
        if (filtered && acc.level !== "full") return false;
        return !masked(acc);
      });
    return { ids, accs };
  }

  const service = {
    parse,
    match,

    /** Словарь для чипов и автодополнения: значения полей — системное имя и отображаемое (R-5.3). */
    vocabulary(viewer: UserRow): TqlVocabulary {
      const named = (rows: { key: string | null; name: string }[]) =>
        rows.map((row) => ({ name: row.key || row.name, label: row.name }));
      const people = (
        db
          .prepare(
            `SELECT u.name, c.username FROM users u LEFT JOIN catalog_profiles c ON c.user_id = u.id
             WHERE u.deactivated_at IS NULL AND ${visibleSql(viewer, "u.is_test")} ORDER BY u.name COLLATE NOCASE`,
          )
          .all() as { name: string; username: string | null }[]
      ).map((row) => ({ name: row.username ?? row.name, label: row.name }));
      const statuses = [
        ...new Set(
          (db.prepare("SELECT name FROM scheme_statuses ORDER BY position").all() as { name: string }[]).map(
            (row) => row.name,
          ),
        ),
      ];
      const outcomes = new Map<string, string>();
      for (const row of db.prepare("SELECT outcomes FROM ticket_types").all() as { outcomes: string }[]) {
        for (const outcome of JSON.parse(row.outcomes) as { key: string; label: string }[])
          outcomes.set(outcome.key, outcome.label);
      }
      const spaces = (
        db
          .prepare(`SELECT slug, name, id FROM spaces WHERE ${visibleSql(viewer)} ORDER BY name COLLATE NOCASE`)
          .all() as {
          slug: string;
          name: string;
          id: string;
        }[]
      ).filter((row) => {
        try {
          requireVisibleSpace(db, viewer, row.id);
          return true;
        } catch {
          return false;
        }
      });
      return {
        customFields: customFields().map((field) => ({
          key: field.key,
          name: (db.prepare("SELECT name FROM ticket_fields WHERE id = ?").get(field.id) as { name: string }).name,
          kind: field.kind,
        })),
        values: {
          type: named(
            db.prepare("SELECT key, name FROM ticket_types ORDER BY name").all() as { key: string; name: string }[],
          ),
          status: statuses.map((name) => ({ name, label: name })),
          statusCategory: [
            { name: "queue", label: "queue" },
            { name: "active", label: "active" },
            { name: "done", label: "done" },
          ],
          resolution: [...outcomes].map(([name, label]) => ({ name, label })),
          zone: STARTER_ZONES.map((zone) => ({ name: zone.key, label: zone.name })),
          space: spaces.map((row) => ({ name: row.slug, label: row.name })),
          team: named(
            db
              .prepare(`SELECT key, name FROM feature_teams WHERE ${visibleSql(viewer)} ORDER BY name COLLATE NOCASE`)
              .all() as {
              key: string | null;
              name: string;
            }[],
          ),
          guild: named(
            db
              .prepare(`SELECT key, name FROM guilds WHERE ${visibleSql(viewer)} ORDER BY name COLLATE NOCASE`)
              .all() as {
              key: string | null;
              name: string;
            }[],
          ),
          person: people,
          priority: [...PRIORITIES].reverse().map((name) => ({ name, label: name })),
          bool: [
            { name: "true", label: "true" },
            { name: "false", label: "false" },
          ],
          linkType: named(
            db.prepare("SELECT key, name FROM link_types ORDER BY name").all() as { key: string; name: string }[],
          ),
        },
      };
    },

    search(
      viewer: UserRow,
      input: { q: string; spaceId?: string; limit?: number; offset?: number },
    ): SearchResult<TicketSummary & { spaceId: string }> {
      const started = performance.now();
      const query = parse(input.q);
      const { ids, accs } = match(viewer, query, { spaceId: input.spaceId });
      const offset = input.offset ?? 0;
      const page = ids.slice(offset, offset + (input.limit ?? 100));
      const rows = page.length
        ? (db
            .prepare(`SELECT t.* FROM tickets t JOIN json_each(?) j ON j.value = t.id ORDER BY j.key`)
            .all(JSON.stringify(page)) as TicketRow[])
        : [];
      const items = tickets.summaries(viewer, rows, accs).map((item, index) => ({
        ...item,
        spaceId: (rows[index] as TicketRow).space_id,
      }));
      return {
        items,
        total: ids.length,
        query: printTql(query),
        tree: query,
        tookMs: Math.round(performance.now() - started),
      };
    },

    // ---- Сохранённые фильтры ----

    filters(viewer: UserRow, spaceId?: string): SavedFilter[] {
      const ctx = access.context(viewer);
      const rows = db
        .prepare(
          `SELECT f.*, u.name AS owner_name FROM saved_filters f LEFT JOIN users u ON u.id = f.owner_id
           WHERE ${visibleSql(viewer, "f.is_test")} AND (f.owner_id = ? OR f.shared = 1)
             ${spaceId ? "AND (f.space_id = ? OR f.shared = 0)" : ""}
           ORDER BY f.shared DESC, f.name COLLATE NOCASE`,
        )
        .all(viewer.id, ...(spaceId ? [spaceId] : [])) as FilterRow[];
      return rows
        .filter((row) => {
          if (!row.shared || !row.space_id) return row.owner_id === viewer.id;
          try {
            requireVisibleSpace(db, viewer, row.space_id);
            return true;
          } catch {
            return false;
          }
        })
        .map((row) => toFilter(viewer, row, ctx));
    },

    saveFilter(viewer: UserRow, input: SavedFilterInput, id?: string): SavedFilter {
      const ctx = access.context(viewer);
      const name = input.name.trim();
      if (!name) {
        throw new AppError(400, "validation_failed", "Name the filter", [{ field: "name", message: "required" }]);
      }
      // Тот же разборщик: сломанный запрос не сохраняется.
      const query = printTql(parse(input.query));
      const shared = Boolean(input.shared);
      const spaceId = shared ? (input.spaceId ?? null) : (input.spaceId ?? null);
      if (shared) {
        if (!spaceId) {
          throw new AppError(400, "validation_failed", "A filter for everyone belongs to a space", [
            { field: "spaceId", message: "choose a space" },
          ]);
        }
        requireVisibleSpace(db, viewer, spaceId);
        if (!access.spaceRights(viewer, spaceId, ctx).has("boards_space")) {
          throw new AppError(403, "forbidden", "Saving filters for everyone needs the «Configure space boards» right", [
            { field: "shared", message: "the «boards_space» right is missing" },
          ]);
        }
      } else if (spaceId) requireVisibleSpace(db, viewer, spaceId);
      const now = Date.now();
      if (id) {
        const current = db.prepare("SELECT * FROM saved_filters WHERE id = ?").get(id) as FilterRow | undefined;
        if (!current || !toFilter(viewer, { ...current, owner_name: null }, ctx).canEdit) {
          throw new AppError(404, "not_found", "Filter not found");
        }
        db.prepare(
          "UPDATE saved_filters SET name = ?, query = ?, shared = ?, space_id = ?, updated_at = ? WHERE id = ?",
        ).run(name, query, Number(shared), spaceId, now, id);
      } else {
        id = randomUUID();
        db.prepare(
          `INSERT INTO saved_filters (id, name, query, owner_id, space_id, shared, is_test, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, name, query, viewer.id, spaceId, Number(shared), createdAsTest(viewer), now, now);
      }
      return service.filters(viewer).find((item) => item.id === id) as SavedFilter;
    },

    deleteFilter(viewer: UserRow, id: string) {
      const current = db.prepare("SELECT * FROM saved_filters WHERE id = ?").get(id) as FilterRow | undefined;
      if (!current || !toFilter(viewer, { ...current, owner_name: null }, access.context(viewer)).canEdit) {
        throw new AppError(404, "not_found", "Filter not found");
      }
      db.prepare("DELETE FROM saved_filters WHERE id = ?").run(id);
    },
  };

  interface FilterRow {
    id: string;
    name: string;
    query: string;
    owner_id: string | null;
    owner_name: string | null;
    space_id: string | null;
    shared: number;
    updated_at: number;
  }

  /** Править общий фильтр может автор и тот, у кого право «Настраивать доски пространства» без ограничения. */
  function toFilter(viewer: UserRow, row: FilterRow, ctx: ViewerContext): SavedFilter {
    const own = row.owner_id === viewer.id;
    const admin =
      row.shared === 1 && row.space_id ? access.spaceRights(viewer, row.space_id, ctx).has("configure") : false;
    return {
      id: row.id,
      name: row.name,
      query: row.query,
      spaceId: row.space_id,
      shared: row.shared === 1,
      owner: row.owner_id ? { id: row.owner_id, name: row.owner_name ?? "" } : null,
      canEdit: own || admin || viewer.role === "superadmin",
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  return service;
}

export type TqlService = ReturnType<typeof tqlService>;

// ---- HTTP ----

const filterSchema = {
  type: "object",
  required: ["id", "name", "query", "spaceId", "shared", "owner", "canEdit", "updatedAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    query: { type: "string" },
    spaceId: { type: ["string", "null"] },
    shared: { type: "boolean" },
    owner: {
      anyOf: [{ type: "null" }, { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } }],
    },
    canEdit: { type: "boolean" },
    updatedAt: { type: "string" },
  },
} as const;
const filterBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "query"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    query: { type: "string", maxLength: 4000 },
    shared: { type: "boolean" },
    spaceId: { type: ["string", "null"], maxLength: 64 },
  },
} as const;

export const tqlRoutes: FastifyPluginAsync<{ db: Database; keyPrefix: string }> = async (app, { db, keyPrefix }) => {
  const service = tqlService(db, ticketService(db, keyPrefix));
  const tags = ["search"];

  app.get(
    "/api/v1/search",
    {
      schema: {
        tags,
        summary:
          "TQL or plain words (full text: key, title, description, comments, old number); limited by the viewer's rights",
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["q"],
          properties: {
            q: { type: "string", maxLength: 4000 },
            spaceId: { type: "string", maxLength: 64 },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "total", "query", "tree", "tookMs"],
            properties: {
              items: { type: "array", items: { type: "object", additionalProperties: true } },
              total: { type: "integer" },
              query: { type: "string" },
              tree: { type: "object", additionalProperties: true },
              tookMs: { type: "integer" },
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) =>
      service.search(
        requireAuth(request).user,
        request.query as { q: string; spaceId?: string; limit?: number; offset?: number },
      ),
  );

  app.get(
    "/api/v1/search/vocabulary",
    {
      schema: {
        tags,
        summary: "Values for chips and autocomplete: system name and display name of each value",
        response: { 200: { type: "object", additionalProperties: true }, ...problemResponses },
      },
    },
    async (request) => service.vocabulary(requireAuth(request).user),
  );

  app.get(
    "/api/v1/filters",
    {
      schema: {
        tags,
        summary: "Saved filters: mine and the ones shared in spaces I can see",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { spaceId: { type: "string", maxLength: 64 } },
        },
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: filterSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({
      items: service.filters(requireAuth(request).user, (request.query as { spaceId?: string }).spaceId),
    }),
  );

  app.post(
    "/api/v1/filters",
    {
      schema: {
        tags,
        summary: "Save a filter: personal, or shared in a space (needs «Configure space boards»)",
        body: filterBody,
        response: { 201: filterSchema, ...problemResponses },
      },
    },
    async (request, reply) =>
      reply.status(201).send(service.saveFilter(requireAuth(request).user, request.body as SavedFilterInput)),
  );

  app.put(
    "/api/v1/filters/:id",
    {
      schema: {
        tags,
        summary: "Change a saved filter",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } },
        body: filterBody,
        response: { 200: filterSchema, ...problemResponses },
      },
    },
    async (request) =>
      service.saveFilter(
        requireAuth(request).user,
        request.body as SavedFilterInput,
        (request.params as { id: string }).id,
      ),
  );

  app.delete(
    "/api/v1/filters/:id",
    {
      schema: {
        tags,
        summary: "Delete a saved filter",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } },
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      service.deleteFilter(requireAuth(request).user, (request.params as { id: string }).id);
      return reply.status(204).send();
    },
  );
};
