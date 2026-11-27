import { randomUUID } from "node:crypto";
import {
  type BulkEditInput,
  canTransition,
  cancelTarget,
  CANCELLED_OUTCOME,
  mapStatusOnTypeChange,
  missingRequirements,
  type ArchiveReason,
  type ChecklistItem,
  type EntryRequirement,
  type FieldValue,
  type PersonRef,
  type Priority,
  type ParentTrace,
  type Progress,
  type RelatedTicket,
  type Right,
  type ScaledRange,
  type StatusCategory,
  type StatusScheme,
  type Ticket,
  type TicketCreateInput,
  type TicketPatch,
  type TicketPermissions,
  type TicketLink,
  type TicketSummary,
  type TitleOnlyTicket,
  type Visibility,
  type VisibilityAllowEntry,
  type VisibilityInput,
  type WorkflowStatus,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError } from "../errors.js";
import type { UserRow } from "../auth/sessions.js";
import { accessService, forbidden, type TicketAccess, type ViewerContext } from "../access/service.js";
import { createdAsTest, toPersonRef, visibleSql, type PersonRefRow } from "../directory/common.js";
import { requireVisibleSpace } from "../spaces/routes.js";
import { json, placeholders } from "../ticket-types/common.js";
import { schemeService } from "../ticket-types/schemes.js";
import { notifier } from "../notifications/service.js";
import { canBeParent, typeService } from "../ticket-types/types.js";
import { historyService, type Change, type HistoryActor } from "./history.js";
import { numberingService } from "./numbering.js";
import { rollupService } from "./rollups.js";
import { treeStore } from "./tree.js";

/**
 * Тикеты (R-2.5, R-2.6, R-2.10, R-2.11, R-3.1; YT-06, docs/adr/0012).
 * Каждое чтение и изменение проверяет права и видимость (R-2.20, R-3.2; YT-08, docs/adr/0014).
 * Каждое изменение проверяет версию: устаревшая правка не сохраняется, клиент получает актуальное
 * состояние и сам показывает, что изменилось (R-3.1). Изменение пересчитывает свёртки предков (YT-10).
 */
export interface TicketRow {
  id: string;
  number: number;
  key: string;
  space_id: string;
  type_id: string;
  status_id: string;
  outcome: string | null;
  title: string;
  description: string;
  checklist: string;
  field_values: string;
  priority: Priority;
  tags: string;
  start_date: string | null;
  end_date: string | null;
  blocked: number;
  blocked_reason: string | null;
  cancel_reason: string | null;
  archived_at: number | null;
  archive_reason: ArchiveReason | null;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  visibility: Visibility | null;
  progress_done: number | null;
  progress_total: number | null;
  progress_percent: number | null;
  rollup_start: string | null;
  rollup_end: string | null;
  rollup_estimates: string;
  close_suggested: number;
  is_test: number;
  deleted_at: number | null;
  deleted_by: string | null;
  trash_batch_id: string | null;
  purged_at: number | null;
  legacy_number: string | null;
}

type Role = "assignee" | "customer" | "tester" | "watcher";

const REQUIREMENT_TEXT: Record<EntryRequirement["kind"], string> = {
  field: "fill in the field",
  people: "assign",
  description: "fill in the description",
  checklist_done: "tick every checklist item",
};

const GOAL_TYPE_KEY = "goal";

export const progressOf = (
  row: Pick<TicketRow, "progress_done" | "progress_total" | "progress_percent">,
): Progress | null =>
  row.progress_percent === null || row.progress_total === null
    ? null
    : { done: row.progress_done ?? 0, total: row.progress_total, percent: row.progress_percent };

export function ticketService(db: Database, keyPrefix: string) {
  const types = typeService(db);
  const schemes = schemeService(db);
  const history = historyService(db);
  const access = accessService(db);
  const tree = treeStore(db);
  const rollups = rollupService(db, tree, history);
  const numbering = numberingService(db, tree, history);

  /** Тикет по ключу или id; тестовые видны только тестовым (docs/adr/0006). Права — отдельно. */
  function baseRow(viewer: UserRow, keyOrId: string): TicketRow | undefined {
    return db
      .prepare(
        `SELECT t.* FROM tickets t WHERE (t.key = ? OR t.id = ?) AND t.deleted_at IS NULL AND ${visibleSql(viewer, "t.is_test")}`,
      )
      .get(keyOrId.toUpperCase(), keyOrId) as TicketRow | undefined;
  }

  /** Удалённый тикет (в корзине или очищенный) по ключу или id — для корзины и понятной ошибки. */
  function deletedRow(viewer: UserRow, keyOrId: string): TicketRow | undefined {
    return db
      .prepare(
        `SELECT t.* FROM tickets t WHERE (t.key = ? OR t.id = ?) AND t.deleted_at IS NOT NULL AND ${visibleSql(viewer, "t.is_test")}`,
      )
      .get(keyOrId.toUpperCase(), keyOrId) as TicketRow | undefined;
  }

  /**
   * Ссылка на удалённый тикет объясняет, что с ним: «в корзине» (с правом вернуть) или «удалён окончательно».
   * Тому, кто тикет не видел бы, — обычный 404 (R-2.17).
   */
  function explainDeleted(viewer: UserRow, keyOrId: string, ctx?: ViewerContext): never {
    const gone = deletedRow(viewer, keyOrId);
    const acc = gone ? access.evaluate(viewer, gone.id, ctx) : null;
    if (!gone || !acc || acc.level === "none") throw new AppError(404, "not_found", "Ticket not found");
    if (gone.purged_at !== null) {
      throw new AppError(410, "ticket_purged", `${gone.key} was deleted for good; its key is never reused`, undefined, {
        ticket: { key: gone.key, title: gone.title },
      });
    }
    throw new AppError(404, "ticket_in_trash", `${gone.key} is in the trash`, undefined, {
      ticket: {
        key: gone.key,
        title: gone.title,
        deletedAt: new Date(gone.deleted_at as number).toISOString(),
        deletedBy: personRef(gone.deleted_by),
        canRestore: acc.rights.has("restore"),
      },
    });
  }

  const titleOnly = (item: TicketRow): TitleOnlyTicket => ({
    key: item.key,
    title: item.title,
    typeId: item.type_id,
    progress: progressOf(item),
  });

  /**
   * Тикет, доступный зрителю. Недоступный — 404, как несуществующий (R-2.17).
   * «Только заголовок» — 403 с названием и прогрессом: содержимое не отдаётся (R-2.20).
   */
  function load(viewer: UserRow, keyOrId: string, ctx?: ViewerContext): { row: TicketRow; acc: TicketAccess } {
    const found = baseRow(viewer, keyOrId);
    if (!found) explainDeleted(viewer, keyOrId, ctx);
    const acc = access.evaluate(viewer, found.id, ctx);
    if (acc.level === "none") throw new AppError(404, "not_found", "Ticket not found");
    if (acc.level === "title") {
      throw new AppError(
        403,
        "ticket_title_only",
        "Only the title of this ticket is open to you. Ask the people on its access list for the content.",
        undefined,
        { ticket: titleOnly(found) },
      );
    }
    return { row: found, acc };
  }

  function requireRight(acc: TicketAccess, right: Right) {
    if (!acc.rights.has(right)) throw forbidden(right);
  }

  function people(ids: string[]) {
    if (ids.length === 0) return new Map<string, { role: Role; person: PersonRef }[]>();
    const rows = db
      .prepare(
        `SELECT p.ticket_id AS ticketId, p.role, u.id, u.name, u.email, u.deactivated_at IS NOT NULL AS deactivated
         FROM ticket_people p JOIN users u ON u.id = p.user_id WHERE p.ticket_id IN (${placeholders(ids)})
         ORDER BY p.position, u.name COLLATE NOCASE`,
      )
      .all(...ids) as (PersonRefRow & { ticketId: string; role: Role })[];
    const map = new Map<string, { role: Role; person: PersonRef }[]>();
    for (const item of rows) {
      map.set(item.ticketId, [...(map.get(item.ticketId) ?? []), { role: item.role, person: toPersonRef(item) }]);
    }
    return map;
  }

  function personRef(id: string | null) {
    if (!id) return null;
    const found = db
      .prepare("SELECT id, name, email, deactivated_at IS NOT NULL AS deactivated FROM users WHERE id = ?")
      .get(id) as PersonRefRow | undefined;
    return found ? toPersonRef(found) : null;
  }

  const NO_PERMISSIONS: TicketPermissions = {
    comment: false,
    edit: false,
    status: false,
    assign: false,
    dates: false,
    move: false,
    trash: false,
    visibility: false,
    create: false,
    export: false,
  };

  /** Тикет как он есть — для журнала и внутренних проверок, без учёта зрителя. */
  function snapshot(item: TicketRow): Ticket {
    const roles = people([item.id]).get(item.id) ?? [];
    const of = (role: Role) => roles.filter((entry) => entry.role === role).map((entry) => entry.person);
    return {
      id: item.id,
      key: item.key,
      number: item.number,
      spaceId: item.space_id,
      typeId: item.type_id,
      statusId: item.status_id,
      outcome: item.outcome,
      title: item.title,
      description: item.description,
      checklist: json<ChecklistItem[]>(item.checklist, []),
      values: json<Record<string, FieldValue>>(item.field_values, {}),
      priority: item.priority,
      tags: json<string[]>(item.tags, []),
      startDate: item.start_date,
      endDate: item.end_date,
      blocked: item.blocked === 1,
      blockedReason: item.blocked_reason,
      cancelReason: item.cancel_reason,
      archived:
        item.archived_at === null || item.archive_reason === null
          ? null
          : { reason: item.archive_reason, at: new Date(item.archived_at).toISOString() },
      legacyNumber: item.legacy_number,
      people: {
        assignees: of("assignee"),
        customer: of("customer")[0] ?? null,
        tester: of("tester")[0] ?? null,
        watchers: of("watcher"),
      },
      version: item.version,
      createdBy: personRef(item.created_by),
      updatedBy: personRef(item.updated_by),
      createdAt: new Date(item.created_at).toISOString(),
      updatedAt: new Date(item.updated_at).toISOString(),
      visibility: { own: item.visibility, effective: item.visibility ?? "open", inheritedFrom: null, allow: [] },
      numbers: [],
      permissions: NO_PERMISSIONS,
      masked: [],
      relations: { parents: [], children: [], coverage: 0, links: [], traces: [] },
      rollup: {
        progress: progressOf(item),
        startDate: item.rollup_start,
        endDate: item.rollup_end,
        datesDiffer: false,
        estimates: json<Record<string, ScaledRange>>(item.rollup_estimates, {}),
        closeSuggested: item.close_suggested === 1,
      },
    };
  }

  function coverage(ids: readonly string[]): Map<string, number> {
    if (ids.length === 0) return new Map();
    const result = new Map<string, number>();
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500);
      for (const row of db
        .prepare(
          `SELECT c.descendant_id AS id, count(*) AS n FROM ticket_closure c
           JOIN tickets a ON a.id = c.ancestor_id JOIN ticket_types ty ON ty.id = a.type_id
           WHERE c.depth > 0 AND ty.key = ? AND c.descendant_id IN (${placeholders(chunk)}) GROUP BY c.descendant_id`,
        )
        .all(GOAL_TYPE_KEY, ...chunk) as { id: string; n: number }[]) {
        result.set(row.id, row.n);
      }
    }
    return result;
  }

  /** Связанные тикеты глазами зрителя: недоступный — без ключа и названия (R-2.17). */
  function related(
    viewer: UserRow,
    ids: readonly string[],
    ctx: ViewerContext,
    inChecklist = new Set<string>(),
    numberFor: (id: string) => string | undefined = () => undefined,
  ) {
    if (ids.length === 0) return [];
    const accs = access.evaluateMany(viewer, ids, ctx);
    const rows = new Map(
      (
        db
          .prepare(
            `SELECT t.*, s.name AS status_name, s.category, sp.name AS space_name FROM tickets t
             JOIN scheme_statuses s ON s.id = t.status_id JOIN spaces sp ON sp.id = t.space_id
             WHERE t.id IN (${placeholders([...ids])})`,
          )
          .all(...ids) as (TicketRow & { status_name: string; category: StatusCategory; space_name: string })[]
      ).map((row) => [row.id, row]),
    );
    const roles = people([...ids]);
    return ids.map((id): RelatedTicket => {
      const row = rows.get(id);
      const acc = accs.get(id);
      if (!row || !acc || acc.level === "none" || (row.is_test === 1 && !viewer.isTest)) return { available: false };
      const full = acc.level === "full";
      return {
        available: true,
        key: row.key,
        title: row.title,
        typeId: row.type_id,
        spaceId: row.space_id,
        spaceName: row.space_name,
        statusName: full ? row.status_name : "",
        category: full ? row.category : "queue",
        outcome: full ? row.outcome : null,
        assignees: full
          ? (roles.get(id) ?? []).filter((entry) => entry.role === "assignee").map((entry) => entry.person)
          : [],
        progress: progressOf(row),
        titleOnly: !full,
        ...(inChecklist.has(row.key) ? { inChecklist: true } : {}),
        ...(numberFor(id) ? { number: numberFor(id) as string } : {}),
      };
    });
  }

  function visibilityOf(viewer: UserRow, item: TicketRow, ctx: ViewerContext) {
    const allow = db
      .prepare(
        `SELECT a.subject_kind AS kind, a.subject_id AS id,
             coalesce(u.name, ft.name, g.name, a.subject_id) AS name
           FROM ticket_visibility_allow a
           LEFT JOIN users u ON a.subject_kind = 'person' AND u.id = a.subject_id
           LEFT JOIN feature_teams ft ON a.subject_kind = 'team' AND ft.id = a.subject_id
           LEFT JOIN guilds g ON a.subject_kind = 'guild' AND g.id = a.subject_id
           WHERE a.ticket_id = ? ORDER BY name COLLATE NOCASE`,
      )
      .all(item.id) as VisibilityAllowEntry[];
    let effective: Visibility = item.visibility ?? "open";
    let inheritedFrom: string | null = null;
    if (!item.visibility) {
      const source = db
        .prepare(
          `SELECT s.id, s.key, s.visibility FROM ticket_restrictions r JOIN tickets s ON s.id = r.source_id
           WHERE r.ticket_id = ? ORDER BY s.visibility = 'hidden' DESC LIMIT 1`,
        )
        .get(item.id) as { id: string; key: string; visibility: Visibility } | undefined;
      if (source) {
        // У потомка «только заголовок» предка значит «скрыт» для посторонних (R-2.20).
        effective = "hidden";
        inheritedFrom = access.evaluate(viewer, source.id, ctx).level === "full" ? source.key : null;
      }
    }
    return { own: item.visibility, effective, inheritedFrom, allow };
  }

  /**
   * Связи R-2.13 тикета глазами зрителя (YT-12): подпись своей стороны («блокирует» / «заблокирован»),
   * недоступный тикет — без ключа и названия (R-2.17).
   */
  function linksFor(viewer: UserRow, ticketId: string, ctx: ViewerContext): TicketLink[] {
    const rows = db
      .prepare(
        `SELECT l.id, l.from_id, l.to_id, t.id AS type_id, t.key, t.name, t.inverse_name, t.symmetric
         FROM ticket_links l JOIN link_types t ON t.id = l.type_id WHERE l.from_id = ? OR l.to_id = ? ORDER BY l.created_at`,
      )
      .all(ticketId, ticketId) as {
      id: string;
      from_id: string;
      to_id: string;
      type_id: string;
      key: string;
      name: string;
      inverse_name: string;
      symmetric: number;
    }[];
    if (!rows.length) return [];
    const others = related(
      viewer,
      rows.map((row) => (row.from_id === ticketId ? row.to_id : row.from_id)),
      ctx,
    );
    return rows.map((row, index) => {
      const direction = row.from_id === ticketId ? "out" : "in";
      return {
        id: row.id,
        typeId: row.type_id,
        typeKey: row.key,
        direction,
        label: direction === "out" || row.symmetric === 1 ? row.name : row.inverse_name,
        ticket: others[index] ?? { available: false },
      };
    });
  }

  /**
   * Следы удалённых родителей (R-2.8): ключ и название сохранены в самом следе и видны даже после очистки.
   * Показываем, пока ребёнок не привязан заново.
   */
  function tracesFor(ticketId: string): ParentTrace[] {
    const rows = db
      .prepare(
        `SELECT tr.id, tr.parent_id, tr.parent_key, tr.parent_title, tr.created_at, tr.created_by, p.purged_at,
           (SELECT count(*) FROM parent_traces o JOIN tickets c ON c.id = o.child_id
             WHERE o.parent_id = tr.parent_id AND o.child_id <> tr.child_id AND o.relinked_at IS NULL
               AND c.deleted_at IS NULL) AS others
         FROM parent_traces tr JOIN tickets p ON p.id = tr.parent_id
         WHERE tr.child_id = ? AND tr.relinked_at IS NULL AND p.deleted_at IS NOT NULL ORDER BY tr.created_at`,
      )
      .all(ticketId) as {
      id: string;
      parent_id: string;
      parent_key: string;
      parent_title: string;
      created_at: number;
      created_by: string | null;
      purged_at: number | null;
      others: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      parentKey: row.parent_key,
      parentTitle: row.parent_title,
      parentState: row.purged_at === null ? "trash" : "purged",
      removedAt: new Date(row.created_at).toISOString(),
      removedBy: personRef(row.created_by),
      others: row.others,
    }));
  }

  /** Тикет глазами зрителя: маска полей, права для кнопок, связи, свёртки. */
  function hydrate(viewer: UserRow, item: TicketRow, acc?: TicketAccess, ctx = access.context(viewer)): Ticket {
    const rights = acc ?? access.evaluate(viewer, item.id, ctx);
    const ticket = snapshot(item);
    const masked = access.maskedFields(rights.profiles);
    for (const key of masked) delete ticket.values[key];
    ticket.masked = [...masked];
    const spaceRights = access.spaceRights(viewer, item.space_id, ctx);
    const can = (right: Right) => rights.rights.has(right);
    ticket.permissions = {
      comment: can("comment"),
      edit: can("edit"),
      status: can("status"),
      assign: can("assign"),
      dates: can("dates"),
      move: can("move"),
      trash: can("trash"),
      visibility: can("visibility"),
      create: spaceRights.has("create"),
      export: can("export"),
    };
    ticket.visibility = visibilityOf(viewer, item, ctx);
    const checklistChildren = new Set(ticket.checklist.map((entry) => entry.childKey).filter(Boolean) as string[]);
    // Номера в потоке (R-2.9): свои по путям и номера на каждой связи.
    const parentIds = tree.parents(item.id);
    const childIds = tree.children(item.id);
    const numbers = numbering.numbers([item.id, ...childIds]);
    const own = numbers.get(item.id) ?? [];
    const parentAccess = access.evaluateMany(viewer, parentIds, ctx);
    const keys = new Map(
      parentIds.length
        ? (
            db.prepare(`SELECT id, key FROM tickets WHERE id IN (${placeholders(parentIds)})`).all(...parentIds) as {
              id: string;
              key: string;
            }[]
          ).map((row) => [row.id, row.key])
        : [],
    );
    ticket.numbers = own.map((entry) => ({
      number: entry.number,
      parentKey:
        entry.parentId && (parentAccess.get(entry.parentId)?.level ?? "none") !== "none"
          ? (keys.get(entry.parentId) ?? null)
          : null,
    }));
    ticket.relations = {
      parents: related(viewer, parentIds, ctx, new Set(), (parentId) =>
        own
          .filter((entry) => entry.parentId === parentId)
          .map((entry) => entry.number)
          .join(", "),
      ),
      children: related(viewer, childIds, ctx, checklistChildren, (childId) =>
        (numbers.get(childId) ?? [])
          .filter((entry) => entry.parentId === item.id)
          .map((entry) => entry.number)
          .join(", "),
      ),
      coverage: coverage([item.id]).get(item.id) ?? 0,
      links: linksFor(viewer, item.id, ctx),
      traces: tracesFor(item.id),
    };
    for (const key of masked) delete ticket.rollup.estimates[key];
    const differ = (manual: string | null, rolled: string | null) => Boolean(manual && rolled && manual !== rolled);
    ticket.rollup.datesDiffer = differ(item.start_date, item.rollup_start) || differ(item.end_date, item.rollup_end);
    return ticket;
  }

  /** Устаревшая версия не сохраняется: в ответе — актуальный тикет (R-3.1). */
  function checkVersion(viewer: UserRow, current: TicketRow, version: number) {
    if (current.version !== version) {
      throw new AppError(
        409,
        "version_conflict",
        "The ticket was changed by someone else. Review the current version and apply your change again.",
        undefined,
        { current: hydrate(viewer, current) },
      );
    }
  }

  const byId = (id: string) => db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow;
  const actorOf = (viewer: UserRow, detail?: string | null): HistoryActor => ({
    id: viewer.id,
    name: viewer.name,
    source: "person",
    detail: detail ?? null,
  });

  /**
   * Сохраняет изменение и пишет в журнал всё, что поменялось (R-2.25), в одной транзакции;
   * затем пересчитывает свёртки тикета и его предков (R-2.12).
   * before — состояние до изменения, если часть правок уже сделана в этой же транзакции (люди).
   */
  /** Наблюдателям — смена статуса (R-2.27): «откуда → куда»; группировку и права делает уведомитель. */
  function notifyStatus(viewer: UserRow, id: string, from: string, to: string) {
    const watchers = (
      db.prepare("SELECT user_id FROM ticket_people WHERE ticket_id = ? AND role = 'watcher'").all(id) as {
        user_id: string;
      }[]
    ).map((row) => row.user_id);
    if (!watchers.length) return;
    const name = (statusId: string) =>
      (db.prepare("SELECT name FROM scheme_statuses WHERE id = ?").get(statusId) as { name: string } | undefined)
        ?.name ?? null;
    notifier(db).publish({
      kind: "status_changed",
      actorId: viewer.id,
      recipients: watchers,
      entries: [{ ticketId: id, from: name(from), to: name(to) }],
    });
  }

  function bump(id: string, viewer: UserRow, sets: [string, unknown][], before?: Ticket) {
    const statusBefore = byId(id).status_id;
    db.transaction(() => {
      const initial = before ?? snapshot(byId(id));
      const now = Date.now();
      const all: [string, unknown][] = [...sets, ["updated_at", now], ["updated_by", viewer.id]];
      db.prepare(
        `UPDATE tickets SET ${all.map(([column]) => `${column} = ?`).join(", ")}, version = version + 1 WHERE id = ?`,
      ).run(...all.map(([, value]) => value), id);
      history.record(id, actorOf(viewer), history.diff(initial, snapshot(byId(id))), now);
      rollups.recompute([id]);
    })();
    const statusAfter = byId(id).status_id;
    if (statusAfter !== statusBefore) notifyStatus(viewer, id, statusBefore, statusAfter);
  }

  function schemeFor(viewer: UserRow, item: Pick<TicketRow, "type_id" | "space_id">): StatusScheme {
    return schemes.get(viewer, item.type_id, item.space_id);
  }

  function requirePeople(viewer: UserRow, ids: readonly string[], field: string) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return unique;
    const found = db
      .prepare(
        `SELECT id FROM users WHERE id IN (${placeholders(unique)}) AND deactivated_at IS NULL AND ${visibleSql(viewer)}`,
      )
      .all(...unique) as { id: string }[];
    if (found.length !== unique.length) {
      throw new AppError(400, "validation_failed", "Unknown or deactivated person", [
        { field, message: "choose active people from the directory" },
      ]);
    }
    return unique;
  }

  function writePeople(ticketId: string, role: Role, ids: readonly string[]) {
    db.prepare("DELETE FROM ticket_people WHERE ticket_id = ? AND role = ?").run(ticketId, role);
    const insert = db.prepare("INSERT INTO ticket_people (ticket_id, user_id, role, position) VALUES (?, ?, ?, ?)");
    ids.forEach((id, position) => insert.run(ticketId, id, role, position));
  }

  function nextNumber() {
    db.prepare("UPDATE ticket_counter SET last_number = last_number + 1 WHERE id = 1").run();
    return (db.prepare("SELECT last_number AS value FROM ticket_counter WHERE id = 1").get() as { value: number })
      .value;
  }

  /** Пункт-ребёнок ссылается только на настоящего ребёнка; его «готово» ставит свёртка. */
  function cleanChecklist(ticketId: string, items: readonly ChecklistItem[]) {
    const seen = new Set<string>();
    const childKeys = new Set(
      (
        db
          .prepare("SELECT t.key FROM ticket_parents p JOIN tickets t ON t.id = p.child_id WHERE p.parent_id = ?")
          .all(ticketId) as { key: string }[]
      ).map((row) => row.key),
    );
    return items
      .map((item) => {
        const childKey = item.childKey?.toUpperCase() ?? null;
        if (childKey && !childKeys.has(childKey)) {
          throw new AppError(400, "validation_failed", "A checklist item can point only to a child of this ticket", [
            { field: "checklist", message: `${childKey} is not a child` },
          ]);
        }
        return {
          id: item.id || randomUUID(),
          text: item.text.trim(),
          done: Boolean(item.done),
          ...(childKey ? { childKey } : {}),
        };
      })
      .filter((item) => item.text && !seen.has(item.id) && seen.add(item.id));
  }

  function cleanTags(tags: readonly string[]) {
    const seen = new Set<string>();
    return tags
      .map((tag) => tag.trim())
      .filter((tag) => tag && !seen.has(tag.toLocaleLowerCase("ru")) && seen.add(tag.toLocaleLowerCase("ru")));
  }

  const linkText = (item: Pick<TicketRow, "id" | "key" | "title">) => ({
    raw: item.id,
    text: `${item.key} ${item.title}`,
  });

  /**
   * Проверки связи parent → child: циклы и ограничители подчинения (R-2.8, R-2.7).
   * Связь между пространствами разрешена (R-2.17).
   */
  function checkLink(parent: TicketRow, child: TicketRow) {
    if (tree.isAncestorOrSelf(child.id, parent.id)) {
      throw new AppError(
        422,
        "hierarchy_cycle",
        `${child.key} cannot become its own ancestor: ${parent.key} is already below it in the tree`,
        [{ field: "parentKey", message: "a cycle" }],
      );
    }
    const space = db.prepare("SELECT enforce_subordination AS e FROM spaces WHERE id = ?").get(child.space_id) as {
      e: number;
    };
    const allowed = (
      db.prepare("SELECT parent_type_id AS id FROM ticket_type_parents WHERE type_id = ?").all(child.type_id) as {
        id: string;
      }[]
    ).map((row) => row.id);
    if (!canBeParent(space.e === 1, allowed, parent.type_id)) {
      const names = db.prepare("SELECT name FROM ticket_types WHERE id = ?");
      const childType = (names.get(child.type_id) as { name: string }).name;
      const parentType = (names.get(parent.type_id) as { name: string }).name;
      throw new AppError(
        422,
        "subordination_violation",
        `In this space a «${childType}» cannot be placed under a «${parentType}»`,
        [{ field: "parentKey", message: "the type rules forbid it" }],
      );
    }
  }

  /** Связь в той же транзакции: замыкание, видимость ветки, история обеих сторон. Свёртку пересчитывает вызывающий. */
  function attach(viewer: UserRow, parent: TicketRow, child: TicketRow, position?: number, detail?: string) {
    checkLink(parent, child);
    tree.link(parent.id, child.id, viewer.id, position);
    access.refreshRestrictions([child.id], tree.topo);
    const now = Date.now();
    history.record(child.id, actorOf(viewer, detail), [{ field: "parents", from: null, to: linkText(parent) }], now);
    history.record(parent.id, actorOf(viewer, detail), [{ field: "children", from: null, to: linkText(child) }], now);
  }

  function detach(viewer: UserRow, pairs: { parent: TicketRow; child: TicketRow }[], detail?: string) {
    tree.unlink(pairs.map((pair) => ({ parentId: pair.parent.id, childId: pair.child.id })));
    access.refreshRestrictions(
      pairs.map((pair) => pair.child.id),
      tree.topo,
    );
    const now = Date.now();
    for (const { parent, child } of pairs) {
      history.record(child.id, actorOf(viewer, detail), [{ field: "parents", from: linkText(parent), to: null }], now);
      history.record(parent.id, actorOf(viewer, detail), [{ field: "children", from: linkText(child), to: null }], now);
    }
  }

  function insertTicket(viewer: UserRow, input: TicketCreateInput, spaceId: string, detail?: string) {
    const type = types.get(viewer, input.typeId);
    const template = input.templateId ? types.template(viewer, input.templateId) : null;
    if (template && template.typeId !== type.id) {
      throw new AppError(400, "validation_failed", "The template belongs to another type", [
        { field: "templateId", message: "choose a template of this type" },
      ]);
    }
    const first = schemes.get(viewer, type.id, spaceId).statuses[0];
    if (!first) throw new AppError(409, "conflict", "The type has no statuses");
    const id = randomUUID();
    const now = Date.now();
    const number = nextNumber();
    db.prepare(
      `INSERT INTO tickets (id, number, key, space_id, type_id, status_id, title, description, checklist, field_values,
         is_test, created_by, updated_by, created_at, updated_at, status_changed_at, root_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      number,
      `${keyPrefix}-${number}`,
      spaceId,
      type.id,
      first.id,
      input.title.trim(),
      template?.description ?? "",
      JSON.stringify((template?.checklist ?? []).map((text) => ({ id: randomUUID(), text, done: false }))),
      JSON.stringify(template?.values ?? {}),
      createdAsTest(viewer),
      viewer.id,
      viewer.id,
      now,
      now,
      now,
      numbering.rootPosition(spaceId),
    );
    tree.addNode(id);
    const changes: Change[] = history.diff(null, snapshot(byId(id)));
    if (template)
      changes.splice(1, 0, { field: "template", from: null, to: { raw: template.id, text: template.name } });
    history.record(id, actorOf(viewer, detail), changes, now);
    return byId(id);
  }

  /** Право «Создавать» в пространстве (R-2.17: предлагаются только такие пространства). */
  function requireCreate(viewer: UserRow, spaceId: string, ctx?: ViewerContext) {
    const space = requireVisibleSpace(db, viewer, spaceId);
    if (!access.spaceRights(viewer, space.id, ctx).has("create")) throw forbidden("create");
    return space;
  }

  /** Строки списка глазами зрителя: «только заголовок» — без статуса, людей и приоритета (R-2.20). */
  function summaries(viewer: UserRow, visible: readonly TicketRow[], accs: Map<string, TicketAccess>): TicketSummary[] {
    void viewer;
    const roles = people(visible.filter((item) => accs.get(item.id)?.level === "full").map((item) => item.id));
    const reach = coverage(visible.map((item) => item.id));
    const flow = numbering.numbers(visible.map((item) => item.id));
    return visible.map((item): TicketSummary => {
      const full = accs.get(item.id)?.level === "full";
      return {
        id: item.id,
        key: item.key,
        title: item.title,
        typeId: item.type_id,
        statusId: full ? item.status_id : "",
        outcome: full ? item.outcome : null,
        priority: full ? item.priority : "normal",
        assignees: full
          ? (roles.get(item.id) ?? []).filter((entry) => entry.role === "assignee").map((entry) => entry.person)
          : [],
        blocked: full && item.blocked === 1,
        archived: item.archived_at !== null,
        updatedAt: new Date(item.updated_at).toISOString(),
        titleOnly: !full,
        progress: progressOf(item),
        coverage: reach.get(item.id) ?? 0,
        numbers: (flow.get(item.id) ?? []).map((entry) => entry.number),
      };
    });
  }

  const service = {
    access,
    tree,
    rollups,
    numbering,
    linksFor,
    history,
    baseRow,
    load,
    deletedRow,
    personRef,
    requireRight,
    snapshot,
    related,
    coverage,
    checkLink,
    attach,
    detach,
    insertTicket,
    requireCreate,
    linkText,
    actorOf,
    byId,
    /** Тикет как строка БД, если зрителю открыто содержимое (для журнала и комментариев). */
    row(viewer: UserRow, keyOrId: string) {
      return load(viewer, keyOrId).row;
    },
    hydrate,
    get(viewer: UserRow, keyOrId: string) {
      const ctx = access.context(viewer);
      const { row, acc } = load(viewer, keyOrId, ctx);
      return hydrate(viewer, row, acc, ctx);
    },

    summaries,

    list(
      viewer: UserRow,
      query: {
        spaceId: string;
        archived?: "exclude" | "include" | "only";
        sort?: "number" | "coverage" | "flow";
        minCoverage?: number;
        /** Только эти тикеты (результат TQL из строки поиска, YT-15). */
        only?: ReadonlySet<string>;
      },
    ) {
      const space = requireVisibleSpace(db, viewer, query.spaceId);
      // Архив скрыт из выборок по умолчанию (R-2.11).
      const archived =
        query.archived === "only"
          ? "t.archived_at IS NOT NULL"
          : query.archived === "include"
            ? "1 = 1"
            : "t.archived_at IS NULL";
      const only = query.only ? [...query.only] : null;
      const rows = (
        only
          ? only.length
            ? db
                .prepare(
                  `SELECT t.* FROM tickets t JOIN json_each(?) j ON j.value = t.id
                   WHERE t.space_id = ? AND t.deleted_at IS NULL AND ${archived} ORDER BY t.number DESC LIMIT 2000`,
                )
                .all(JSON.stringify(only), space.id)
            : []
          : db
              .prepare(
                `SELECT t.* FROM tickets t WHERE t.space_id = ? AND t.deleted_at IS NULL AND ${archived}
                   AND ${visibleSql(viewer, "t.is_test")}
                 ORDER BY t.number DESC LIMIT 2000`,
              )
              .all(space.id)
      ) as TicketRow[];
      const accs = access.evaluateMany(
        viewer,
        rows.map((row) => row.id),
      );
      let result = summaries(
        viewer,
        rows.filter((item) => (accs.get(item.id)?.level ?? "none") !== "none"),
        accs,
      );
      if (query.minCoverage !== undefined) {
        const min = query.minCoverage;
        result = result.filter((item) => item.coverage >= min);
      }
      if (query.sort === "coverage") result.sort((a, b) => b.coverage - a.coverage || b.key.localeCompare(a.key));
      if (query.sort === "flow") {
        // Порядок потока: по первому номеру, части сравниваются как числа (1.10 после 1.9).
        const parts = (item: TicketSummary) => (item.numbers[0] ?? "").split(".").map(Number);
        result.sort((a, b) => {
          const x = parts(a);
          const y = parts(b);
          for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
            const diff = (x[index] ?? -1) - (y[index] ?? -1);
            if (diff) return diff;
          }
          return 0;
        });
      }
      return result;
    },

    /**
     * Создание по шаблону или одной строкой (название + тип). Начальный статус — первый в схеме.
     * С parentKey / childKey тикет сразу связывается: «+ ребёнок» и «+ родитель» (R-2.17).
     */
    create(viewer: UserRow, input: TicketCreateInput, detail?: string) {
      const ctx = access.context(viewer);
      const space = requireCreate(viewer, input.spaceId, ctx);
      const parent = input.parentKey ? load(viewer, input.parentKey, ctx) : null;
      const child = input.childKey ? load(viewer, input.childKey, ctx) : null;
      if (child) requireRight(child.acc, "move");
      let id = "";
      db.transaction(() => {
        const created = insertTicket(viewer, input, space.id, detail);
        id = created.id;
        if (parent) attach(viewer, parent.row, created, tree.positionBefore(parent.row.id, input.beforeKey));
        const childWasRoot = child ? tree.parents(child.row.id).length === 0 : false;
        if (child) attach(viewer, created, child.row);
        // Номер в потоке: новый тикет встаёт на своё место, соседи после него сдвигаются (R-2.9).
        numbering.renumber(
          {
            tickets: [created.id],
            parents: parent ? [parent.row.id] : [],
            spaces: child && childWasRoot ? [child.row.space_id] : [],
          },
          { kind: "inserted", key: created.key },
        );
        rollups.recompute([created.id, ...(child ? [child.row.id] : [])]);
      })();
      return service.get(viewer, id);
    },

    update(viewer: UserRow, keyOrId: string, patch: TicketPatch) {
      const ctx = access.context(viewer);
      const { row: current, acc } = load(viewer, keyOrId, ctx);
      checkVersion(viewer, current, patch.version);
      const sets: [string, unknown][] = [];
      const need = new Set<Right>();
      const before = snapshot(current);
      // Право нужно только на то, что действительно меняется: клиент может прислать всю форму целиком.
      const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
      const sameSet = (a: readonly string[], b: readonly string[]) => !differs([...a].sort(), [...b].sort());
      const want = (right: Right, changed: boolean) => {
        if (changed) need.add(right);
      };
      if (patch.title !== undefined) {
        want("edit", patch.title.trim() !== current.title);
        sets.push(["title", patch.title.trim()]);
      }
      if (patch.description !== undefined) {
        want("edit", patch.description !== current.description);
        sets.push(["description", patch.description]);
      }
      if (patch.checklist !== undefined) {
        const cleaned = cleanChecklist(current.id, patch.checklist);
        want("edit", differs(cleaned, before.checklist));
        sets.push(["checklist", JSON.stringify(cleaned)]);
      }
      if (patch.priority !== undefined) {
        want("edit", patch.priority !== current.priority);
        sets.push(["priority", patch.priority]);
      }
      if (patch.tags !== undefined) {
        const cleaned = cleanTags(patch.tags);
        want("edit", differs(cleaned, before.tags));
        sets.push(["tags", JSON.stringify(cleaned)]);
      }
      if (patch.startDate !== undefined) {
        want("dates", patch.startDate !== current.start_date);
        sets.push(["start_date", patch.startDate]);
      }
      if (patch.endDate !== undefined) {
        want("dates", patch.endDate !== current.end_date);
        sets.push(["end_date", patch.endDate]);
      }
      if (patch.blocked !== undefined) {
        const reason = patch.blockedReason?.trim() || null;
        if (patch.blocked && !reason) {
          throw new AppError(400, "validation_failed", "Say why the ticket is blocked", [
            { field: "blockedReason", message: "a reason is required" },
          ]);
        }
        want("edit", patch.blocked !== before.blocked || (patch.blocked && reason !== current.blocked_reason));
        sets.push(["blocked", Number(patch.blocked)], ["blocked_reason", patch.blocked ? reason : null]);
      }
      if (patch.values !== undefined) {
        const masked = access.maskedFields(acc.profiles);
        // Поле под маской клиент не знает: пустое значение для него — «не трогать», значение — отказ.
        const hidden = Object.entries(patch.values).filter(
          ([key, value]) => masked.has(key) && value !== null && value !== "",
        );
        if (hidden.length) {
          throw new AppError(403, "forbidden", "Some fields are hidden from your role", [
            ...hidden.map(([key]) => ({ field: `values.${key}`, message: "hidden by the field mask" })),
          ]);
        }
        const incoming = Object.fromEntries(Object.entries(patch.values).filter(([key]) => !masked.has(key)));
        // Проверяем только присланные значения: скрытые значения полей, убранных из типа, не трогаем (R-2.7).
        const provided = Object.fromEntries(
          Object.entries(incoming).filter(([, value]) => value !== null && value !== ""),
        );
        const checked = types.checkValues(viewer, current.type_id, provided);
        const previous = json<Record<string, FieldValue>>(current.field_values, {});
        const next = { ...previous, ...checked };
        for (const [key, value] of Object.entries(incoming)) if (value === null || value === "") delete next[key];
        want(
          "edit",
          Object.keys({ ...next, ...previous }).some((key) => differs(next[key], previous[key])),
        );
        sets.push(["field_values", JSON.stringify(next)]);
      }
      const peoplePatch = patch.people;
      const ids = (role: "assignees" | "watchers") => before.people[role].map((person) => person.id);
      if (peoplePatch?.assigneeIds) want("assign", !sameSet(peoplePatch.assigneeIds, ids("assignees")));
      if (peoplePatch?.watcherIds) want("edit", !sameSet(peoplePatch.watcherIds, ids("watchers")));
      if (peoplePatch?.customerId !== undefined)
        want("edit", (peoplePatch.customerId ?? null) !== (before.people.customer?.id ?? null));
      if (peoplePatch?.testerId !== undefined)
        want("edit", (peoplePatch.testerId ?? null) !== (before.people.tester?.id ?? null));
      for (const right of need) requireRight(acc, right);
      const assignees = peoplePatch?.assigneeIds
        ? requirePeople(viewer, peoplePatch.assigneeIds, "people.assigneeIds")
        : undefined;
      const watchers = peoplePatch?.watcherIds
        ? requirePeople(viewer, peoplePatch.watcherIds, "people.watcherIds")
        : undefined;
      const customer =
        peoplePatch?.customerId === undefined
          ? undefined
          : requirePeople(viewer, peoplePatch.customerId ? [peoplePatch.customerId] : [], "people.customerId");
      const tester =
        peoplePatch?.testerId === undefined
          ? undefined
          : requirePeople(viewer, peoplePatch.testerId ? [peoplePatch.testerId] : [], "people.testerId");
      const assignedBefore = new Set(
        (
          db.prepare("SELECT user_id FROM ticket_people WHERE ticket_id = ? AND role = 'assignee'").all(current.id) as {
            user_id: string;
          }[]
        ).map((row) => row.user_id),
      );
      db.transaction(() => {
        if (assignees) writePeople(current.id, "assignee", assignees);
        if (watchers) writePeople(current.id, "watcher", watchers);
        if (customer) writePeople(current.id, "customer", customer);
        if (tester) writePeople(current.id, "tester", tester);
        bump(current.id, viewer, sets, before);
      })();
      // Назначение (R-2.27): только тем, кого добавили.
      const added = (assignees ?? []).filter((id) => !assignedBefore.has(id));
      if (added.length) {
        notifier(db).publish({
          kind: "assigned",
          actorId: viewer.id,
          recipients: added,
          entries: [{ ticketId: current.id }],
        });
      }
      return service.get(viewer, current.id);
    },

    /**
     * Массовая правка (R-3.1): всё или ничего, в одной транзакции; права и условия входа — как у одиночной.
     * Статус задаётся именем: у каждого типа своя схема. Повтор того же запроса ничего не меняет.
     */
    bulk(viewer: UserRow, input: BulkEditInput): Ticket[] {
      const keys = [...new Set(input.keys.map((key) => key.toUpperCase()))];
      const result: Ticket[] = [];
      db.transaction(() => {
        for (const key of keys) {
          let ticket = service.get(viewer, key);
          if (input.status) {
            const target = schemeFor(viewer, byId(ticket.id)).statuses.find(
              (status) => status.name.toLowerCase() === input.status?.toLowerCase(),
            );
            if (!target) {
              throw new AppError(422, "transition_blocked", `${ticket.key} has no status «${input.status}»`, [
                { field: "status", message: ticket.key },
              ]);
            }
            if (target.id !== ticket.statusId) {
              ticket = service.transition(viewer, ticket.id, {
                version: ticket.version,
                statusId: target.id,
                ...(input.outcome ? { outcome: input.outcome } : {}),
              });
            }
          }
          if (input.priority || input.assigneeIds || input.watcherIds) {
            ticket = service.update(viewer, ticket.id, {
              version: ticket.version,
              ...(input.priority ? { priority: input.priority } : {}),
              ...(input.assigneeIds || input.watcherIds
                ? {
                    people: {
                      ...(input.assigneeIds ? { assigneeIds: input.assigneeIds } : {}),
                      ...(input.watcherIds ? { watcherIds: input.watcherIds } : {}),
                    },
                  }
                : {}),
            });
          }
          result.push(ticket);
        }
      })();
      return result;
    },

    /** «Назначить на себя»: добавляет себя к исполнителям, остальных не трогает. */
    assignMe(viewer: UserRow, keyOrId: string, version: number) {
      const { row, acc } = load(viewer, keyOrId);
      requireRight(acc, "assign");
      const current = snapshot(row);
      const ids = current.people.assignees.map((person) => person.id);
      if (ids.includes(viewer.id)) {
        checkVersion(viewer, row, version);
        return service.get(viewer, row.id);
      }
      return service.update(viewer, keyOrId, { version, people: { assigneeIds: [...ids, viewer.id] } });
    },

    /** Смена статуса по правилам схемы: порядок (если строгий), обязательное на входе, исход у завершённого. */
    transition(viewer: UserRow, keyOrId: string, input: { version: number; statusId: string; outcome?: string }) {
      const { row: current, acc } = load(viewer, keyOrId);
      requireRight(acc, "status");
      checkVersion(viewer, current, input.version);
      if (current.archived_at !== null) throw new AppError(409, "conflict", "Return the ticket from the archive first");
      const scheme = schemeFor(viewer, current);
      const target = scheme.statuses.find((status) => status.id === input.statusId);
      if (!target) {
        throw new AppError(400, "validation_failed", "The status is not in this type's scheme", [
          { field: "statusId", message: "unknown status" },
        ]);
      }
      if (!canTransition(scheme, current.status_id, target.id)) {
        const from = scheme.statuses.find((status) => status.id === current.status_id);
        throw new AppError(
          422,
          "transition_blocked",
          `In this scheme you can move from "${from?.name}" only to the next status or back`,
          [{ field: "statusId", message: "strict order" }],
        );
      }
      if (target.category === "done") {
        if (!input.outcome || !target.outcomes.includes(input.outcome)) {
          throw new AppError(400, "validation_failed", "Choose an outcome", [
            { field: "outcome", message: `one of: ${target.outcomes.join(", ")}` },
          ]);
        }
        if (input.outcome === CANCELLED_OUTCOME) {
          throw new AppError(400, "validation_failed", "Cancel the ticket with a reason instead", [
            { field: "outcome", message: "use the cancel action" },
          ]);
        }
      }
      service.assertRequirements(target, snapshot(current));
      bump(current.id, viewer, [
        ["status_id", target.id],
        ["outcome", target.category === "done" ? input.outcome : null],
        ["cancel_reason", null],
        ["status_changed_at", Date.now()],
      ]);
      return service.get(viewer, current.id);
    },

    /** Незаполненное обязательное на входе блокирует переход понятной ошибкой. */
    assertRequirements(target: WorkflowStatus, ticket: Ticket) {
      const missing = missingRequirements(target, ticket);
      if (!missing.length) return;
      const fields = new Map(
        (
          db
            .prepare(
              "SELECT f.key, f.name FROM ticket_type_fields tf JOIN ticket_fields f ON f.id = tf.field_id WHERE tf.type_id = ?",
            )
            .all(ticket.typeId) as { key: string; name: string }[]
        ).map((field) => [field.key, field.name]),
      );
      throw new AppError(
        422,
        "transition_blocked",
        `To move to "${target.name}", fill in what the status requires`,
        missing.map((requirement) => ({
          field:
            requirement.kind === "field"
              ? `values.${requirement.fieldKey}`
              : requirement.kind === "people"
                ? `people.${requirement.role}`
                : requirement.kind,
          message:
            requirement.kind === "field"
              ? `${REQUIREMENT_TEXT.field}: ${fields.get(requirement.fieldKey) ?? requirement.fieldKey}`
              : requirement.kind === "people"
                ? `${REQUIREMENT_TEXT.people}: ${requirement.role}`
                : REQUIREMENT_TEXT[requirement.kind],
        })),
      );
    },

    /** Отмена из любого статуса: в Done с исходом «отменено» и обязательной причиной (R-2.10). */
    cancel(viewer: UserRow, keyOrId: string, input: { version: number; reason: string }) {
      const { row: current, acc } = load(viewer, keyOrId);
      requireRight(acc, "status");
      checkVersion(viewer, current, input.version);
      const reason = input.reason.trim();
      if (!reason) {
        throw new AppError(400, "validation_failed", "Say why the ticket is cancelled", [
          { field: "reason", message: "a reason is required" },
        ]);
      }
      const target = cancelTarget(schemeFor(viewer, current));
      if (!target) throw new AppError(409, "conflict", "The scheme has no status for cancelling");
      bump(current.id, viewer, [
        ["status_id", target.id],
        ["outcome", CANCELLED_OUTCOME],
        ["cancel_reason", reason],
        ["status_changed_at", Date.now()],
      ]);
      return service.get(viewer, current.id);
    },

    /** Архив — признак с причиной; статус сохраняется и возвращается с тикетом (R-2.11). */
    archive(viewer: UserRow, keyOrId: string, input: { version: number; reason: ArchiveReason }) {
      const { row: current, acc } = load(viewer, keyOrId);
      requireRight(acc, "status");
      checkVersion(viewer, current, input.version);
      if (current.archived_at !== null) throw new AppError(409, "conflict", "The ticket is already archived");
      bump(current.id, viewer, [
        ["archived_at", Date.now()],
        ["archive_reason", input.reason],
      ]);
      return service.get(viewer, current.id);
    },

    unarchive(viewer: UserRow, keyOrId: string, version: number) {
      const { row: current, acc } = load(viewer, keyOrId);
      requireRight(acc, "status");
      checkVersion(viewer, current, version);
      bump(current.id, viewer, [
        ["archived_at", null],
        ["archive_reason", null],
      ]);
      return service.get(viewer, current.id);
    },

    /**
     * Смена типа (R-2.7): статус переносится по имени, иначе по категории; если вариантов несколько —
     * спрашиваем (status_choice_required со списком). Значения полей, которых нет в новом типе, скрываются, но не стираются.
     */
    changeType(viewer: UserRow, keyOrId: string, input: { version: number; typeId: string; statusId?: string }) {
      const { row: current, acc } = load(viewer, keyOrId);
      requireRight(acc, "edit");
      checkVersion(viewer, current, input.version);
      const type = types.get(viewer, input.typeId);
      const from = schemeFor(viewer, current).statuses.find((status) => status.id === current.status_id);
      const target = schemes.get(viewer, type.id, current.space_id).statuses;
      let statusId = input.statusId;
      if (statusId && !target.some((status) => status.id === statusId)) {
        throw new AppError(400, "validation_failed", "The status is not in the new type's scheme", [
          { field: "statusId", message: "unknown status" },
        ]);
      }
      if (!statusId) {
        const mapping = from
          ? mapStatusOnTypeChange(from, target)
          : { kind: "ask" as const, candidates: target.map((s) => s.id) };
        if (mapping.kind === "ask") {
          throw new AppError(409, "status_choice_required", "Choose the status in the new type", undefined, {
            candidates: mapping.candidates,
          });
        }
        statusId = mapping.statusId;
      }
      const status = target.find((item) => item.id === statusId) as WorkflowStatus;
      const outcome =
        status.category === "done"
          ? current.outcome && status.outcomes.includes(current.outcome)
            ? current.outcome
            : (status.outcomes.find((item) => item !== CANCELLED_OUTCOME) ?? status.outcomes[0] ?? null)
          : null;
      bump(current.id, viewer, [
        ["type_id", type.id],
        ["status_id", status.id],
        ["outcome", outcome],
        ...(status.id !== current.status_id ? ([["status_changed_at", Date.now()]] as [string, unknown][]) : []),
      ]);
      return service.get(viewer, current.id);
    },

    /**
     * Видимость (R-2.20): «открыт», «только заголовок», «скрыт» или наследовать (null).
     * Наследуется вниз по ветке; явная видимость потомка важнее наследуемой.
     */
    setVisibility(viewer: UserRow, realUser: UserRow, keyOrId: string, input: VisibilityInput) {
      const { row: current, acc } = load(viewer, keyOrId);
      requireRight(acc, "visibility");
      checkVersion(viewer, current, input.version);
      const allow = input.allow ?? [];
      for (const entry of allow) {
        const table = entry.kind === "person" ? "users" : entry.kind === "team" ? "feature_teams" : "guilds";
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(entry.id)) {
          throw new AppError(400, "validation_failed", "Unknown person or group in the access list", [
            { field: "allow", message: `${entry.kind} ${entry.id} not found` },
          ]);
        }
      }
      const before = visibilityOf(viewer, current, access.context(viewer));
      db.transaction(() => {
        db.prepare("DELETE FROM ticket_visibility_allow WHERE ticket_id = ?").run(current.id);
        const insert = db.prepare(
          "INSERT OR IGNORE INTO ticket_visibility_allow (ticket_id, subject_kind, subject_id) VALUES (?, ?, ?)",
        );
        if (input.visibility && input.visibility !== "open") {
          for (const entry of allow) insert.run(current.id, entry.kind, entry.id);
        }
        const now = Date.now();
        db.prepare(
          "UPDATE tickets SET visibility = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?",
        ).run(input.visibility, now, viewer.id, current.id);
        access.refreshRestrictions([current.id], tree.topo);
        const text = (visibility: Visibility | null, names: string[]) =>
          `${visibility ?? "inherit"}${names.length ? `: ${names.join(", ")}` : ""}`;
        const after = visibilityOf(viewer, byId(current.id), access.context(viewer));
        history.record(
          current.id,
          actorOf(viewer),
          [
            {
              field: "visibility",
              from: {
                raw: before.own,
                text: text(
                  before.own,
                  before.allow.map((entry) => entry.name),
                ),
              },
              to: {
                raw: input.visibility,
                text: text(
                  input.visibility,
                  after.allow.map((entry) => entry.name),
                ),
              },
            },
          ],
          now,
        );
        access.log(realUser, "ticket.visibility", { key: current.key, visibility: input.visibility, allow });
      })();
      return service.get(viewer, current.id);
    },
  };
  return service;
}

export type TicketService = ReturnType<typeof ticketService>;
