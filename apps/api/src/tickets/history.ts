import type {
  FieldValue,
  HistoryEntry,
  HistorySource,
  HistoryValue,
  PersonRef,
  StatusPeriod,
  Ticket,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { toPersonRef, type PersonRefRow } from "../directory/common.js";
import { json, placeholders } from "../ticket-types/common.js";

/**
 * Неизменяемый журнал изменений тикета (R-2.25; YT-07, docs/adr/0013).
 * Каждое изменение — запись: кто, когда, что, было, стало, источник. Значения хранятся «как есть» (`raw`)
 * и в читаемом виде на момент изменения (`text`): переименование или уход человека историю не портит.
 * Правку и удаление записей запрещают триггеры базы; API таких действий не имеет.
 */
export interface HistoryActor {
  id: string | null;
  name: string | null;
  source: HistorySource;
  detail?: string | null;
}

export interface Change {
  field: string;
  fieldLabel?: string | null;
  from: HistoryValue | null;
  to: HistoryValue | null;
}

interface FieldRow {
  key: string;
  name: string;
  kind: string;
  scale_id: string | null;
  dimension_id: string | null;
}

const value = (raw: unknown, text: string): HistoryValue => ({ raw, text });
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const names = (people: readonly PersonRef[]) => people.map((person) => person.name).join(", ");

export function historyService(db: Database) {
  function lookup(table: string, ids: readonly string[], column = "label") {
    if (ids.length === 0) return new Map<string, string>();
    const rows = db
      .prepare(`SELECT id, ${column} AS text FROM ${table} WHERE id IN (${placeholders(ids)})`)
      .all(...ids) as { id: string; text: string }[];
    return new Map(rows.map((row) => [row.id, row.text]));
  }

  /** Значение поля типа читаемо: метка варианта, имя человека, значение шкалы, название группы. */
  function fieldText(field: FieldRow | undefined, raw: FieldValue | undefined): string {
    if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) return "";
    if (!field) return Array.isArray(raw) ? raw.join(", ") : String(raw);
    const ids = (Array.isArray(raw) ? raw : [raw]).map(String);
    const join = (map: Map<string, string>) => ids.map((id) => map.get(id) ?? id).join(", ");
    switch (field.kind) {
      case "list":
        return join(lookup("ticket_field_options", ids));
      case "person":
        return join(lookup("users", ids, "name"));
      case "estimate": {
        const scale = db.prepare("SELECT kind, unit FROM estimate_scales WHERE id = ?").get(field.scale_id) as
          | { kind: string; unit: string | null }
          | undefined;
        if (scale?.kind === "numeric") return `${String(raw)}${scale.unit ? ` ${scale.unit}` : ""}`;
        return join(lookup("estimate_scale_values", ids));
      }
      case "dimension": {
        const dimension = db.prepare("SELECT kind, source FROM dimensions WHERE id = ?").get(field.dimension_id) as
          | { kind: string; source: string | null }
          | undefined;
        if (dimension?.kind === "list") return join(lookup("dimension_options", ids));
        return join(lookup(dimension?.source === "guilds" ? "guilds" : "feature_teams", ids, "name"));
      }
      default:
        return String(raw);
    }
  }

  function status(id: string | null) {
    if (!id) return null;
    const row = db.prepare("SELECT id, name, category FROM scheme_statuses WHERE id = ?").get(id) as
      | { id: string; name: string; category: string }
      | undefined;
    return row ? value(row, row.name) : value({ id }, id);
  }

  function typeName(id: string) {
    return (
      (db.prepare("SELECT name FROM ticket_types WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? id
    );
  }

  function outcomeLabel(typeId: string, key: string | null) {
    if (!key) return null;
    const outcomes = json<{ key: string; label: string }[]>(
      (db.prepare("SELECT outcomes FROM ticket_types WHERE id = ?").get(typeId) as { outcomes: string } | undefined)
        ?.outcomes ?? "[]",
      [],
    );
    return value(key, outcomes.find((item) => item.key === key)?.label ?? key);
  }

  const service = {
    /** Статус в журнале: id, имя и категория снимком. */
    statusValue: status,
    /** Что изменилось между двумя состояниями тикета; before = null — тикет только что создан. */
    diff(before: Ticket | null, after: Ticket): Change[] {
      if (!before) {
        return [
          { field: "created", from: null, to: value(after.title, after.title) },
          { field: "status", from: null, to: status(after.statusId) },
        ];
      }
      const changes: Change[] = [];
      const plain = (
        field: keyof Ticket,
        text: (raw: never) => string = (raw) => (raw === null ? "" : String(raw)),
      ) => {
        const from = before[field];
        const to = after[field];
        if (!same(from, to)) {
          changes.push({
            field,
            from: from === null ? null : value(from, text(from as never)),
            to: to === null ? null : value(to, text(to as never)),
          });
        }
      };
      plain("title");
      plain("description");
      plain("checklist", (items: Ticket["checklist"]) =>
        items.map((item) => `${item.done ? "☑" : "☐"} ${item.text}`).join("; "),
      );
      if (before.typeId !== after.typeId) {
        changes.push({
          field: "type",
          from: value(before.typeId, typeName(before.typeId)),
          to: value(after.typeId, typeName(after.typeId)),
        });
      }
      if (before.statusId !== after.statusId)
        changes.push({ field: "status", from: status(before.statusId), to: status(after.statusId) });
      if (before.outcome !== after.outcome) {
        changes.push({
          field: "outcome",
          from: outcomeLabel(before.typeId, before.outcome),
          to: outcomeLabel(after.typeId, after.outcome),
        });
      }
      plain("priority");
      plain("tags", (tags: string[]) => tags.join(", "));
      plain("startDate");
      plain("endDate");
      if (before.blocked !== after.blocked || before.blockedReason !== after.blockedReason) {
        const show = (ticket: Ticket) =>
          value(
            { blocked: ticket.blocked, reason: ticket.blockedReason },
            ticket.blocked ? (ticket.blockedReason ?? "") : "",
          );
        changes.push({ field: "blocked", from: show(before), to: show(after) });
      }
      plain("cancelReason");
      if (!same(before.archived?.reason, after.archived?.reason)) {
        changes.push({
          field: "archived",
          from: before.archived ? value(before.archived.reason, before.archived.reason) : null,
          to: after.archived ? value(after.archived.reason, after.archived.reason) : null,
        });
      }
      for (const role of ["assignees", "watchers"] as const) {
        const from = before.people[role];
        const to = after.people[role];
        if (
          !same(
            from.map((p) => p.id),
            to.map((p) => p.id),
          )
        ) {
          changes.push({
            field: `people.${role}`,
            from: from.length
              ? value(
                  from.map((p) => p.id),
                  names(from),
                )
              : null,
            to: to.length
              ? value(
                  to.map((p) => p.id),
                  names(to),
                )
              : null,
          });
        }
      }
      for (const role of ["customer", "tester"] as const) {
        const from = before.people[role];
        const to = after.people[role];
        if (from?.id !== to?.id) {
          changes.push({
            field: `people.${role}`,
            from: from ? value(from.id, from.name) : null,
            to: to ? value(to.id, to.name) : null,
          });
        }
      }
      const keys = [...new Set([...Object.keys(before.values), ...Object.keys(after.values)])];
      if (keys.length) {
        const fields = new Map(
          (
            db
              .prepare(
                `SELECT key, name, kind, scale_id, dimension_id FROM ticket_fields WHERE key IN (${placeholders(keys)})`,
              )
              .all(...keys) as FieldRow[]
          ).map((field) => [field.key, field]),
        );
        for (const key of keys) {
          const from = before.values[key];
          const to = after.values[key];
          if (same(from, to)) continue;
          const field = fields.get(key);
          changes.push({
            field: `values.${key}`,
            fieldLabel: field?.name ?? key,
            from: from === undefined || from === null ? null : value(from, fieldText(field, from)),
            to: to === undefined || to === null ? null : value(to, fieldText(field, to)),
          });
        }
      }
      return changes;
    },

    record(ticketId: string, actor: HistoryActor, changes: readonly Change[], at = Date.now()) {
      const insert = db.prepare(
        `INSERT INTO ticket_history (ticket_id, at, actor_id, actor_name, source, source_detail, field, field_label, from_value, to_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const change of changes) {
        insert.run(
          ticketId,
          at,
          actor.id,
          actor.name,
          actor.source,
          actor.detail ?? null,
          change.field,
          change.fieldLabel ?? null,
          change.from === null ? null : JSON.stringify(change.from),
          change.to === null ? null : JSON.stringify(change.to),
        );
      }
    },

    list(ticketId: string): HistoryEntry[] {
      const rows = db
        .prepare(
          `SELECT h.*, u.id AS user_id, u.name AS user_name, u.email AS user_email, u.deactivated_at IS NOT NULL AS user_deactivated
           FROM ticket_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.ticket_id = ? ORDER BY h.id DESC`,
        )
        .all(ticketId) as {
        id: number;
        at: number;
        actor_name: string | null;
        source: HistorySource;
        source_detail: string | null;
        field: string;
        field_label: string | null;
        from_value: string | null;
        to_value: string | null;
        user_id: string | null;
        user_name: string | null;
        user_email: string | null;
        user_deactivated: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        at: new Date(row.at).toISOString(),
        actor: row.user_id
          ? toPersonRef({
              id: row.user_id,
              name: row.user_name ?? "",
              email: row.user_email,
              deactivated: row.user_deactivated,
            } as PersonRefRow)
          : null,
        actorName: row.actor_name,
        source: row.source,
        sourceDetail: row.source_detail,
        field: row.field,
        fieldLabel: row.field_label,
        from: row.from_value ? json<HistoryValue | null>(row.from_value, null) : null,
        to: row.to_value ? json<HistoryValue | null>(row.to_value, null) : null,
      }));
    },

    /** Последовательность статусов с датами — основа метрик YourDash и старения карточки (R-2.25). */
    statusPeriods(ticketId: string): StatusPeriod[] {
      const rows = (
        db
          .prepare(
            "SELECT at, field, actor_name, to_value FROM ticket_history WHERE ticket_id = ? AND field IN ('status', 'outcome') ORDER BY id",
          )
          .all(ticketId) as { at: number; field: string; actor_name: string | null; to_value: string | null }[]
      ).map((row) => ({ ...row, to: row.to_value ? json<HistoryValue | null>(row.to_value, null) : null }));
      const periods: StatusPeriod[] = [];
      for (const row of rows) {
        if (row.field === "outcome") {
          const last = periods.at(-1);
          if (last && last.leftAt === null) last.outcome = (row.to?.raw as string | undefined) ?? null;
          continue;
        }
        const raw = (row.to?.raw ?? {}) as { id?: string; name?: string; category?: string };
        const last = periods.at(-1);
        if (last) last.leftAt = new Date(row.at).toISOString();
        periods.push({
          statusId: raw.id ?? "",
          name: raw.name ?? row.to?.text ?? "",
          category: raw.category ?? "",
          outcome: null,
          enteredAt: new Date(row.at).toISOString(),
          leftAt: null,
          actorName: row.actor_name,
        });
      }
      return periods;
    },
  };
  return service;
}
