import { randomUUID } from "node:crypto";
import {
  BOARD_SORTS,
  isBoardChip,
  isBoardLanes,
  CARD_DENSITIES,
  DEFAULT_BOARD_PREFS,
  UNMAPPED_ZONE,
  starterZones,
  zoneStatusNames,
  type Board,
  type BoardCard,
  type BoardChip,
  type BoardFilter,
  type BoardCreateTicketInput,
  type BoardInput,
  type BoardLanes,
  type BoardMoveInput,
  type BoardPatch,
  type BoardPrefs,
  type BoardSort,
  type BoardStatusOption,
  type BoardSummary,
  type BoardView,
  type BoardZone,
  type BoardZoneInput,
  type Ticket,
  type TqlExpr,
  type TqlQuery,
  type TqlValue,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import type { UserRow } from "../auth/sessions.js";
import { AppError } from "../errors.js";
import { createdAsTest, visibleSql } from "../directory/common.js";
import { requireVisibleSpace } from "../spaces/routes.js";
import { schemeService } from "../ticket-types/schemes.js";
import { ticketService, type TicketRow } from "../tickets/service.js";
import { tqlService } from "../tickets/tql.js";
import type { ViewerContext } from "../access/service.js";

/**
 * Доски (R-2.18) и зоны (R-2.19), docs/adr/0022.
 * Доска хранит только фильтр, раскладку, дерево зон и ручной порядок; карточки — выборка TQL с правами зрителя.
 */
interface BoardRow {
  id: string;
  name: string;
  kind: "custom" | "mine";
  space_id: string | null;
  owner_id: string | null;
  query: string;
  lanes: BoardLanes;
  sort: BoardSort;
  done_days: number;
  chips: string;
  tql_lanes: string;
  tql_chips: string;
  zones: string;
  is_test: number;
  created_at: number;
  updated_at: number;
}

const DAY = 24 * 60 * 60 * 1000;
export const MINE_QUERY = "assignee = me() and statusCategory != done";
/** Больше карточек доска не рисует (R-3.4: доска до 500 карточек ≤ 2 с); остальное — счётчик и совет сузить фильтр. */
export const CARD_LIMIT = 1000;

const notFound = () => new AppError(404, "not_found", "Board not found");

export function boardService(db: Database, keyPrefix: string) {
  const tickets = ticketService(db, keyPrefix);
  const tql = tqlService(db, tickets);
  const schemes = schemeService(db);
  const { access } = tickets;

  const rowById = (id: string) => db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;

  function space(viewer: UserRow, spaceId: string) {
    try {
      requireVisibleSpace(db, viewer, spaceId);
      return db.prepare("SELECT id, name, slug FROM spaces WHERE id = ?").get(spaceId) as {
        id: string;
        name: string;
        slug: string;
      };
    } catch {
      return null;
    }
  }

  /** Личная — только владельцу; доска пространства — всем, кто видит пространство (R-2.20). */
  function visible(viewer: UserRow, row: BoardRow) {
    if (row.is_test && !viewer.isTest) return false;
    return row.owner_id ? row.owner_id === viewer.id : Boolean(row.space_id && space(viewer, row.space_id));
  }

  function canEdit(viewer: UserRow, row: BoardRow, ctx?: ViewerContext) {
    if (row.owner_id) return row.owner_id === viewer.id;
    return Boolean(row.space_id && access.spaceRights(viewer, row.space_id, ctx).has("boards_space"));
  }

  function load(viewer: UserRow, id: string) {
    const row = rowById(id);
    if (!row || !visible(viewer, row)) throw notFound();
    return row;
  }

  function requireEdit(viewer: UserRow, row: BoardRow) {
    if (!canEdit(viewer, row)) {
      throw new AppError(
        403,
        "forbidden",
        row.owner_id
          ? "Only the owner changes a personal board"
          : "Changing a space board needs the «Configure space boards» right",
      );
    }
  }

  function summary(viewer: UserRow, row: BoardRow, ctx?: ViewerContext): BoardSummary {
    const where = row.space_id ? space(viewer, row.space_id) : null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      owner: where
        ? { kind: "space", spaceId: where.id, spaceName: where.name, spaceSlug: where.slug }
        : { kind: "person", userId: row.owner_id ?? "" },
      query: row.query,
      canEdit: canEdit(viewer, row, ctx),
    };
  }

  function toBoard(viewer: UserRow, row: BoardRow): Board {
    return {
      ...summary(viewer, row),
      lanes: row.lanes,
      sort: row.sort,
      doneDays: row.done_days,
      chips: JSON.parse(row.chips) as BoardChip[],
      tqlLanes: JSON.parse(row.tql_lanes) as BoardFilter[],
      tqlChips: JSON.parse(row.tql_chips) as BoardFilter[],
      zones: JSON.parse(row.zones) as BoardZone[],
    };
  }

  /** Тот же разборщик, что у поиска: сломанный запрос не сохраняется (400 tql_invalid с местом ошибки). */
  const canonical = (query: string) => {
    tql.parse(query);
    return query.trim();
  };

  function validateOptions(input: BoardPatch) {
    const errors: { field: string; message: string }[] = [];
    if (input.lanes !== undefined && !isBoardLanes(input.lanes)) errors.push({ field: "lanes", message: "?" });
    if (input.sort !== undefined && !BOARD_SORTS.includes(input.sort)) errors.push({ field: "sort", message: "?" });
    if (input.chips?.some((chip) => !isBoardChip(chip))) errors.push({ field: "chips", message: "?" });
    for (const [field, list] of [
      ["tqlLanes", input.tqlLanes],
      ["tqlChips", input.tqlChips],
    ] as const) {
      if (!list) continue;
      if (new Set(list.map((item) => item.id)).size !== list.length) errors.push({ field, message: "ids repeat" });
      list.forEach((item, index) => {
        if (!item.name.trim()) errors.push({ field: `${field}.${index}.name`, message: "required" });
        // Сломанный запрос дорожки или чипа не сохраняется: 400 tql_invalid с местом ошибки.
        tql.parse(item.query);
      });
    }
    if (input.doneDays !== undefined && !(Number.isInteger(input.doneDays) && input.doneDays >= 0)) {
      errors.push({ field: "doneDays", message: "0 or more days" });
    }
    if (errors.length) throw new AppError(400, "validation_failed", undefined, errors);
  }

  /** Стартовая личная доска «Мои задачи» (R-2.18): есть у каждого, создаётся при первом обращении. */
  function ensureMine(viewer: UserRow) {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO boards (id, name, kind, owner_id, query, lanes, sort, done_days, chips, zones, is_test, created_by, created_at, updated_at)
       VALUES (?, 'Мои задачи', 'mine', ?, ?, 'none', 'due', 14, '["type"]', ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      viewer.id,
      MINE_QUERY,
      JSON.stringify(starterZones()),
      createdAsTest(viewer),
      viewer.id,
      now,
      now,
    );
  }

  function prefsOf(boardId: string, userId: string): BoardPrefs {
    const row = db.prepare("SELECT prefs FROM board_prefs WHERE board_id = ? AND user_id = ?").get(boardId, userId) as
      | { prefs: string }
      | undefined;
    return { ...DEFAULT_BOARD_PREFS, ...(row ? (JSON.parse(row.prefs) as Partial<BoardPrefs>) : {}) };
  }

  /** Значение условия как текст: «Frogs», "ГД", me(). */
  const valueText = (value: TqlValue | undefined) =>
    !value
      ? ""
      : value.kind === "number"
        ? String(value.value)
        : value.kind === "call"
          ? `${value.name}()`
          : value.text;

  /** Условия «поле = значение» верхнего уровня (первая ветка OR): из них новая карточка берёт команду, стрим, исполнителя. */
  function equalities(where: TqlExpr | null): { field: string; value: string }[] {
    if (!where) return [];
    if (where.kind === "cond" && (where.op === "=" || where.op === "in")) {
      const value = where.op === "in" ? where.values?.[0] : where.value;
      return [{ field: where.field.toLowerCase(), value: valueText(value) }];
    }
    if (where.kind === "and") return where.items.flatMap(equalities);
    if (where.kind === "or") return equalities(where.items[0] ?? null);
    if (where.kind === "group") return equalities(where.item);
    return [];
  }

  const groupId = (table: "feature_teams" | "guilds", value: string) =>
    (
      db
        .prepare(`SELECT id FROM ${table} WHERE lower(key) = lower(?) OR lower(name) = lower(?) LIMIT 1`)
        .get(value, value) as { id: string } | undefined
    )?.id;

  const both = (a: TqlExpr | null, b: TqlExpr | null): TqlExpr | null =>
    a && b
      ? {
          kind: "and",
          items: [
            { kind: "group", item: a },
            { kind: "group", item: b },
          ],
        }
      : (a ?? b);

  /** Свои измерения (R-2.14) — поля вида «измерение», кроме команды и стрима; значения — подписи справочника. */
  function dimensionFields() {
    const fields = db
      .prepare(
        `SELECT f.key, f.name, d.source FROM ticket_fields f JOIN dimensions d ON d.id = f.dimension_id
         WHERE f.kind = 'dimension' AND f.key NOT IN ('team', 'stream') ORDER BY f.name COLLATE NOCASE`,
      )
      .all() as { key: string; name: string; source: "feature_teams" | "guilds" | null }[];
    const labels = new Map<string, string>();
    for (const table of ["dimension_options", "feature_teams", "guilds"] as const) {
      const column = table === "dimension_options" ? "label" : "name";
      for (const item of db.prepare(`SELECT id, ${column} AS label FROM ${table}`).all() as {
        id: string;
        label: string;
      }[])
        labels.set(item.id, item.label);
    }
    return { fields, label: (id: string) => labels.get(id) ?? id };
  }

  /** Карточки доски: выборка TQL глазами зрителя, без «только заголовок» и без старых завершённых. */
  function cards(viewer: UserRow, row: BoardRow, ctx: ViewerContext, refine: TqlExpr | null) {
    const base = tql.parse(row.query);
    const where = both(base.where, refine);
    const { ids, accs } = tql.match(viewer, { where, orderBy: base.orderBy }, { ctx });
    const full = ids.filter((id) => accs.get(id)?.level === "full");
    const empty = {
      cards: [] as BoardCard[],
      schemes: {},
      hiddenDone: 0,
      overflow: 0,
      dimensions: [],
      laneHits: {},
      chipHits: {},
    };
    if (!full.length) return empty;
    const doneBefore = Date.now() - row.done_days * DAY;
    const rows = db
      .prepare(
        `SELECT t.*, s.name AS status_name, s.category AS status_category, s.waiting AS status_waiting
         FROM json_each(?) j JOIN tickets t ON t.id = j.value JOIN scheme_statuses s ON s.id = t.status_id
         ORDER BY j.key`,
      )
      .all(JSON.stringify(full)) as (TicketRow & {
      status_name: string;
      status_category: BoardStatusOption["category"];
      status_waiting: number;
      status_changed_at: number;
    })[];
    const fresh = rows.filter((item) => item.status_category !== "done" || item.status_changed_at >= doneBefore);
    const hiddenDone = rows.length - fresh.length;
    const shown = fresh.slice(0, CARD_LIMIT);
    const overflow = fresh.length - shown.length;
    const summaries = new Map(tickets.summaries(viewer, shown, accs).map((item) => [item.id, item]));
    const list = JSON.stringify(shown.map((item) => item.id));

    const teams = new Map(
      (db.prepare("SELECT id, name FROM feature_teams").all() as { id: string; name: string }[]).map((item) => [
        item.id,
        item.name,
      ]),
    );
    const guilds = new Map(
      (db.prepare("SELECT id, name FROM guilds").all() as { id: string; name: string }[]).map((item) => [
        item.id,
        item.name,
      ]),
    );
    const parentRows = db
      .prepare(
        `SELECT p.child_id, p.parent_id FROM ticket_parents p JOIN json_each(?) j ON j.value = p.child_id
         JOIN tickets t ON t.id = p.parent_id WHERE t.deleted_at IS NULL ORDER BY p.created_at`,
      )
      .all(list) as { child_id: string; parent_id: string }[];
    const parentIds = [...new Set(parentRows.map((item) => item.parent_id))];
    const parentAcc = access.evaluateMany(viewer, parentIds, ctx);
    const parentInfo = new Map(
      (
        db
          .prepare("SELECT t.id, t.key, t.title FROM json_each(?) j JOIN tickets t ON t.id = j.value")
          .all(JSON.stringify(parentIds)) as { id: string; key: string; title: string }[]
      ).map((item) => [item.id, item]),
    );
    const parentsOf = new Map<string, BoardCard["parents"]>();
    for (const link of parentRows) {
      const info = parentInfo.get(link.parent_id);
      const seen = (parentAcc.get(link.parent_id)?.level ?? "none") !== "none";
      parentsOf.set(link.child_id, [
        ...(parentsOf.get(link.child_id) ?? []),
        { id: link.parent_id, key: seen ? (info?.key ?? null) : null, title: seen ? (info?.title ?? null) : null },
      ]);
    }
    const ranks = new Map(
      (
        db.prepare("SELECT ticket_id, rank FROM board_ranks WHERE board_id = ?").all(row.id) as {
          ticket_id: string;
          rank: number;
        }[]
      ).map((item) => [item.ticket_id, item.rank]),
    );

    const dims = dimensionFields();
    const seenDims = new Set<string>();
    const schemeMap: Record<string, BoardStatusOption[]> = {};
    const today = new Date().toISOString().slice(0, 10);
    const result = shown.map((item): BoardCard => {
      const scheme = `${item.type_id}:${item.space_id}`;
      if (!schemeMap[scheme]) {
        schemeMap[scheme] = schemes.get(viewer, item.type_id, item.space_id).statuses.map((status) => ({
          id: status.id,
          name: status.name,
          category: status.category,
          waiting: status.waiting,
          outcomes: status.outcomes,
        }));
      }
      const values = JSON.parse(item.field_values) as Record<string, unknown>;
      const due = typeof values.due_date === "string" ? values.due_date : item.end_date;
      const team = typeof values.team === "string" ? values.team : null;
      const streams = Array.isArray(values.stream) ? (values.stream as string[]) : [];
      const sum = summaries.get(item.id);
      const own: BoardCard["dims"] = {};
      for (const field of dims.fields) {
        const raw = values[field.key];
        const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw]).map(
          String,
        );
        if (!list.length) continue;
        seenDims.add(field.key);
        own[field.key] = list.map((id) => ({ id, name: dims.label(id) }));
      }
      return {
        id: item.id,
        key: item.key,
        title: item.title,
        typeId: item.type_id,
        spaceId: item.space_id,
        statusId: item.status_id,
        statusName: item.status_name,
        category: item.status_category,
        waiting: item.status_waiting === 1,
        outcome: item.outcome,
        scheme,
        version: item.version,
        priority: item.priority,
        assignees: sum?.assignees ?? [],
        numbers: sum?.numbers ?? [],
        due: due ?? null,
        overdue: Boolean(due && due < today && item.status_category !== "done"),
        team: team ? { id: team, name: teams.get(team) ?? team } : null,
        streams: streams.map((id) => ({ id, name: guilds.get(id) ?? id })),
        parents: parentsOf.get(item.id) ?? [],
        progress: sum?.progress ?? null,
        blocked: item.blocked === 1,
        tags: JSON.parse(item.tags) as string[],
        dims: own,
        rank: ranks.get(item.id) ?? null,
        canMove: accs.get(item.id)?.rights.has("status") ?? false,
      };
    });
    // Дорожки и чипы-фильтры TQL: тот же разборщик и те же права; запрос сужен до карточек доски.
    const shownIds = new Set(result.map((card) => card.id));
    const hits = (list: BoardFilter[]) =>
      Object.fromEntries(
        list.map((item) => {
          const query = tql.parse(item.query);
          const found = tql.match(viewer, { where: both(where, query.where), orderBy: [] }, { ctx }).ids;
          return [item.id, found.filter((id) => shownIds.has(id))];
        }),
      );
    return {
      cards: result,
      schemes: schemeMap,
      hiddenDone,
      overflow,
      dimensions: dims.fields.filter((field) => seenDims.has(field.key)).map(({ key, name }) => ({ key, name })),
      laneHits: hits(JSON.parse(row.tql_lanes) as BoardFilter[]),
      chipHits: hits(JSON.parse(row.tql_chips) as BoardFilter[]),
    };
  }

  function writeRanks(boardId: string, order: readonly string[]) {
    const ids = db
      .prepare("SELECT t.id, t.key FROM json_each(?) j JOIN tickets t ON t.key = upper(j.value)")
      .all(JSON.stringify(order)) as { id: string; key: string }[];
    const byKey = new Map(ids.map((item) => [item.key, item.id]));
    const upsert = db.prepare(
      `INSERT INTO board_ranks (board_id, ticket_id, rank) VALUES (?, ?, ?)
       ON CONFLICT (board_id, ticket_id) DO UPDATE SET rank = excluded.rank`,
    );
    order.forEach((key, index) => {
      const id = byKey.get(key.toUpperCase());
      if (id) upsert.run(boardId, id, (index + 1) * 1024);
    });
  }

  const service = {
    list(viewer: UserRow): BoardSummary[] {
      ensureMine(viewer);
      const ctx = access.context(viewer);
      const rows = db
        .prepare(
          `SELECT * FROM boards WHERE (owner_id = ? OR space_id IS NOT NULL) AND ${visibleSql(viewer)}
           ORDER BY kind = 'mine' DESC, name COLLATE NOCASE`,
        )
        .all(viewer.id) as BoardRow[];
      return rows.filter((row) => visible(viewer, row)).map((row) => summary(viewer, row, ctx));
    },

    get(viewer: UserRow, id: string): Board {
      return toBoard(viewer, load(viewer, id));
    },

    /** refine — уточнение фильтра из адреса (?q=): та же проверка запроса, права — как у доски. */
    view(viewer: UserRow, id: string, refine?: string): BoardView & { overflow: number } {
      const started = performance.now();
      const row = load(viewer, id);
      const ctx = access.context(viewer);
      const extra = refine?.trim() ? tql.parse(refine).where : null;
      const result = cards(viewer, row, ctx, extra);
      return {
        board: toBoard(viewer, row),
        prefs: prefsOf(row.id, viewer.id),
        cards: result.cards,
        schemes: result.schemes,
        hiddenDone: result.hiddenDone,
        overflow: result.overflow,
        dimensions: result.dimensions,
        laneHits: result.laneHits,
        chipHits: result.chipHits,
        refine: extra ? (refine?.trim() ?? null) : null,
        tookMs: Math.round(performance.now() - started),
      };
    },

    create(viewer: UserRow, input: BoardInput): Board {
      validateOptions(input);
      const name = input.name.trim();
      if (!name) throw new AppError(400, "validation_failed", undefined, [{ field: "name", message: "required" }]);
      if (input.spaceId) {
        requireVisibleSpace(db, viewer, input.spaceId);
        if (!access.spaceRights(viewer, input.spaceId).has("boards_space")) {
          throw new AppError(403, "forbidden", "Creating a space board needs the «Configure space boards» right");
        }
      }
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO boards (id, name, kind, space_id, owner_id, query, lanes, sort, done_days, chips, tql_lanes, tql_chips, zones, is_test, created_by, created_at, updated_at)
         VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        name,
        input.spaceId ?? null,
        input.spaceId ? null : viewer.id,
        canonical(input.query),
        input.lanes ?? "none",
        input.sort ?? "due",
        input.doneDays ?? 14,
        JSON.stringify(input.chips ?? ["type"]),
        JSON.stringify(input.tqlLanes ?? []),
        JSON.stringify(input.tqlChips ?? []),
        JSON.stringify(starterZones()),
        createdAsTest(viewer),
        viewer.id,
        now,
        now,
      );
      return service.get(viewer, id);
    },

    update(viewer: UserRow, id: string, patch: BoardPatch): Board {
      const row = load(viewer, id);
      requireEdit(viewer, row);
      validateOptions(patch);
      const sets: [string, unknown][] = [];
      if (patch.name !== undefined) {
        if (!patch.name.trim()) {
          throw new AppError(400, "validation_failed", undefined, [{ field: "name", message: "required" }]);
        }
        sets.push(["name", patch.name.trim()]);
      }
      if (patch.query !== undefined) sets.push(["query", canonical(patch.query)]);
      if (patch.lanes !== undefined) sets.push(["lanes", patch.lanes]);
      if (patch.sort !== undefined) sets.push(["sort", patch.sort]);
      if (patch.doneDays !== undefined) sets.push(["done_days", patch.doneDays]);
      if (patch.chips !== undefined) sets.push(["chips", JSON.stringify(patch.chips)]);
      if (patch.tqlLanes !== undefined) sets.push(["tql_lanes", JSON.stringify(patch.tqlLanes)]);
      if (patch.tqlChips !== undefined) sets.push(["tql_chips", JSON.stringify(patch.tqlChips)]);
      sets.push(["updated_at", Date.now()]);
      db.prepare(`UPDATE boards SET ${sets.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`).run(
        ...sets.map(([, value]) => value),
        id,
      );
      return service.get(viewer, id);
    },

    /** Владелец доски перестраивает дерево зон у себя (R-2.19): любая глубина, без циклов, статус — в одной зоне. */
    setZones(viewer: UserRow, id: string, input: BoardZoneInput[]): Board {
      const row = load(viewer, id);
      requireEdit(viewer, row);
      const ids = new Set(input.map((zone) => zone.id));
      const errors: { field: string; message: string }[] = [];
      if (ids.size !== input.length) errors.push({ field: "zones", message: "zone ids repeat" });
      const owner = new Map<string, string>();
      input.forEach((zone, index) => {
        if (!zone.name.trim()) errors.push({ field: `zones.${index}.name`, message: "required" });
        if (zone.id === UNMAPPED_ZONE) errors.push({ field: `zones.${index}.id`, message: "reserved" });
        if (zone.parentId && !ids.has(zone.parentId)) {
          errors.push({ field: `zones.${index}.parentId`, message: "unknown parent" });
        }
        if (zone.wipLimit !== undefined && zone.wipLimit !== null && !(zone.wipLimit >= 1)) {
          errors.push({ field: `zones.${index}.wipLimit`, message: "1 or more" });
        }
        for (const status of zone.statuses) {
          const other = owner.get(status);
          if (other) errors.push({ field: `zones.${index}.statuses`, message: `«${status}» is already in ${other}` });
          owner.set(status, zone.name);
        }
      });
      const parentOf = new Map(input.map((zone) => [zone.id, zone.parentId]));
      for (const zone of input) {
        const seen = new Set<string>();
        let at: string | null | undefined = zone.id;
        while (at) {
          if (seen.has(at)) {
            errors.push({ field: "zones", message: `cycle at ${zone.name}` });
            break;
          }
          seen.add(at);
          at = parentOf.get(at) ?? null;
        }
      }
      if (errors.length) throw new AppError(400, "validation_failed", "The zone tree has errors", errors);
      const zones: BoardZone[] = input.map((zone, index) => ({
        id: zone.id,
        name: zone.name.trim(),
        parentId: zone.parentId,
        position: index,
        statuses: [...new Set(zone.statuses.map((status) => status.trim()).filter(Boolean))],
        wipLimit: zone.wipLimit ?? null,
      }));
      db.prepare("UPDATE boards SET zones = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(zones), Date.now(), id);
      return service.get(viewer, id);
    },

    remove(viewer: UserRow, id: string) {
      const row = load(viewer, id);
      requireEdit(viewer, row);
      if (row.kind === "mine") throw new AppError(409, "conflict", "«My tasks» is everyone's starting board");
      db.prepare("DELETE FROM boards WHERE id = ?").run(id);
    },

    setPrefs(viewer: UserRow, id: string, prefs: BoardPrefs): BoardPrefs {
      const row = load(viewer, id);
      const clean: BoardPrefs = {
        detail: prefs.detail,
        collapsed: [...new Set(prefs.collapsed)].slice(0, 200),
        hiddenLevels: [...new Set(prefs.hiddenLevels)].slice(0, 10),
        density: CARD_DENSITIES.includes(prefs.density) ? prefs.density : "normal",
        chipsOff: [...new Set(prefs.chipsOff)].slice(0, 500),
        lanes: prefs.lanes,
        lanesCollapsed: [...new Set(prefs.lanesCollapsed)].slice(0, 500),
        tqlOn: [...new Set(prefs.tqlOn ?? [])].slice(0, 50),
      };
      db.prepare(
        `INSERT INTO board_prefs (board_id, user_id, prefs, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (board_id, user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
      ).run(row.id, viewer.id, JSON.stringify(clean), Date.now());
      return clean;
    },

    /**
     * Карточку бросили в зону (R-2.19): статус выбирается из статусов зоны, доступных её типу.
     * Нет таких — 422 zone_not_for_type с причиной; несколько и не выбран — 409 status_choice_required с вариантами.
     */
    move(viewer: UserRow, id: string, input: BoardMoveInput): { ticket: Ticket } {
      const row = load(viewer, id);
      const board = toBoard(viewer, row);
      const { row: current, acc } = tickets.load(viewer, input.key);
      tickets.requireRight(acc, "status");
      const zone = board.zones.find((item) => item.id === input.zoneId);
      if (!zone) {
        throw new AppError(422, "zone_not_for_type", "Tickets are moved into zones; «Not mapped» only collects strays");
      }
      const names = new Set(zoneStatusNames(board.zones, zone.id));
      const scheme = schemes.get(viewer, current.type_id, current.space_id);
      const options = scheme.statuses.filter((status) => names.has(status.name));
      const typeName = (
        db.prepare("SELECT name FROM ticket_types WHERE id = ?").get(current.type_id) as { name: string }
      ).name;
      if (!options.length) {
        throw new AppError(
          422,
          "zone_not_for_type",
          `«${typeName}» has no status in the zone «${zone.name}»: its scheme passes this zone by`,
          undefined,
          { zone: zone.name, ticketType: typeName, zoneStatuses: [...names] },
        );
      }
      let target = input.statusId ? options.find((status) => status.id === input.statusId) : undefined;
      if (input.statusId && !target) {
        throw new AppError(422, "zone_not_for_type", `This status is not in the zone «${zone.name}» for «${typeName}»`);
      }
      if (!target) {
        const here = options.find((status) => status.id === current.status_id);
        if (options.length === 1) target = options[0];
        else if (here) target = here;
        else {
          throw new AppError(409, "status_choice_required", `Choose the status in «${zone.name}»`, undefined, {
            candidates: options.map((status) => ({ id: status.id, name: status.name, waiting: status.waiting })),
          });
        }
      }
      const chosen = target as (typeof options)[number];
      const ticket =
        chosen.id === current.status_id
          ? tickets.get(viewer, current.id)
          : tickets.transition(viewer, current.id, {
              version: input.version,
              statusId: chosen.id,
              ...(input.outcome ? { outcome: input.outcome } : {}),
            });
      if (input.order?.length && board.sort === "manual") writeRanks(row.id, input.order.slice(0, CARD_LIMIT));
      return { ticket };
    },

    /** Ручной порядок без смены статуса. */
    reorder(viewer: UserRow, id: string, order: string[]) {
      const row = load(viewer, id);
      if (row.sort !== "manual") {
        throw new AppError(409, "conflict", "Turn on manual order for the board first");
      }
      writeRanks(row.id, order.slice(0, CARD_LIMIT));
    },

    /**
     * «Создать» на доске: тикет в пространстве доски; команда, стрим и «исполнитель — я» берутся из фильтра,
     * чтобы карточка сразу попала на доску. onBoard — попала ли.
     */
    createTicket(viewer: UserRow, id: string, input: BoardCreateTicketInput): { ticket: Ticket; onBoard: boolean } {
      const row = load(viewer, id);
      const spaceId = input.spaceId ?? row.space_id;
      if (!spaceId) {
        throw new AppError(400, "validation_failed", "Choose the space for the new ticket", [
          { field: "spaceId", message: "required" },
        ]);
      }
      let ticket = tickets.create(viewer, { spaceId, typeId: input.typeId, title: input.title });
      const query = tql.parse(row.query);
      const apply = (patch: Record<string, unknown>) => {
        try {
          ticket = tickets.update(viewer, ticket.key, { version: ticket.version, ...patch });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      };
      for (const { field, value } of equalities(query.where)) {
        if (field === "team" || field === "involvedteams") {
          const team = groupId("feature_teams", value);
          if (team && field === "team") apply({ values: { team } });
        } else if (field === "stream") {
          const guild = groupId("guilds", value);
          if (guild) apply({ values: { stream: [guild] } });
        } else if (field === "assignee" && value === "me()") {
          apply({ people: { assigneeIds: [viewer.id] } });
        }
      }
      const probe: TqlQuery = {
        where: {
          kind: "and",
          items: [
            { kind: "cond", field: "key", op: "=", value: { kind: "word", text: ticket.key } },
            ...(query.where ? [query.where] : []),
          ],
        },
        orderBy: [],
      };
      const onBoard = tql.match(viewer, probe, {}).ids.includes(ticket.id);
      return { ticket, onBoard };
    },
  };
  return service;
}

export type BoardService = ReturnType<typeof boardService>;
