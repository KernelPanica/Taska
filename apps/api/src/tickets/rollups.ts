import {
  computeProgress,
  datesRollup,
  DAYS_SCALE_KEY,
  DEFAULT_ROLLUPS,
  estimateIn,
  rollupEstimates,
  statusRollup,
  type ChecklistItem,
  type Estimate,
  type RollupSettings,
  type ScaledRange,
  type StatusCategory,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import type { UserRow } from "../auth/sessions.js";
import { json, placeholders } from "../ticket-types/common.js";
import { scaleService } from "../ticket-types/scales.js";
import type { HistoryActor, historyService } from "./history.js";
import type { TreeStore } from "./tree.js";

/**
 * Свёртки (R-2.12; YT-10, docs/adr/0016): родитель сам знает статус, прогресс, даты и сумму оценок по детям.
 * Считаются для всех детей, включая недоступных зрителю (R-2.17); результат хранится у тикета.
 * Пересчёт идёт снизу вверх по предкам изменённых тикетов в той же транзакции, что и изменение.
 */
interface Row {
  id: string;
  type_id: string;
  space_id: string;
  status_id: string;
  outcome: string | null;
  checklist: string;
  field_values: string;
  start_date: string | null;
  end_date: string | null;
  rollup_start: string | null;
  rollup_end: string | null;
  rollup_estimates: string;
  progress_done: number | null;
  progress_total: number | null;
  progress_percent: number | null;
  close_suggested: number;
  category: StatusCategory;
  rollups: string;
}

/** Внутренний зритель для справочников (шкалы, конвертер): видит всё, ничего не меняет. */
const SYSTEM_VIEWER = { id: "system", role: "superadmin", isTest: true } as unknown as UserRow;

export const ROLLUP_ACTOR: HistoryActor = { id: null, name: null, source: "system", detail: "rollup" };

export function rollupService(db: Database, tree: TreeStore, history: ReturnType<typeof historyService>) {
  const scales = scaleService(db);
  const select = db.prepare(
    `SELECT t.id, t.type_id, t.space_id, t.status_id, t.outcome, t.checklist, t.field_values, t.start_date, t.end_date,
       t.rollup_start, t.rollup_end, t.rollup_estimates, t.progress_done, t.progress_total, t.progress_percent,
       t.close_suggested, s.category, ty.rollups
     FROM tickets t JOIN scheme_statuses s ON s.id = t.status_id JOIN ticket_types ty ON ty.id = t.type_id WHERE t.id = ?`,
  );
  const childRows = db.prepare(
    `SELECT t.id, t.key, t.type_id, t.space_id, t.status_id, t.outcome, t.checklist, t.field_values, t.start_date, t.end_date,
       t.rollup_start, t.rollup_end, t.rollup_estimates, t.progress_done, t.progress_total, t.progress_percent,
       t.close_suggested, s.category, ty.rollups
     FROM ticket_parents p JOIN tickets t ON t.id = p.child_id JOIN scheme_statuses s ON s.id = t.status_id
     JOIN ticket_types ty ON ty.id = t.type_id WHERE p.parent_id = ? ORDER BY p.position`,
  );
  const causedBy = db.prepare(
    "SELECT l.to_id AS id FROM ticket_links l JOIN link_types t ON t.id = l.type_id WHERE t.key = 'causes' AND l.from_id = ?",
  );
  const estimateFields = db.prepare(
    `SELECT f.key, f.scale_id AS scaleId FROM ticket_type_fields tf JOIN ticket_fields f ON f.id = tf.field_id
     WHERE tf.type_id = ? AND f.kind = 'estimate' AND f.scale_id IS NOT NULL ORDER BY tf.position`,
  );
  const inProgressStatus = db.prepare(
    `SELECT ss.id FROM scheme_statuses ss JOIN status_schemes sc ON sc.id = ss.scheme_id
     WHERE sc.type_id = ? AND (sc.space_id = ? OR sc.space_id IS NULL) AND ss.category = 'in_progress'
     ORDER BY sc.space_id IS NULL, ss.position LIMIT 1`,
  );

  const fieldsCache = new Map<string, { key: string; scaleId: string }[]>();
  let scaleCache: ReturnType<typeof scales.list> | null = null;
  const converterCache = new Map<string, ReturnType<typeof scales.converter>>();
  const fieldsOf = (typeId: string) => {
    let found = fieldsCache.get(typeId);
    if (!found) {
      found = estimateFields.all(typeId) as { key: string; scaleId: string }[];
      fieldsCache.set(typeId, found);
    }
    return found;
  };

  /** Оценки тикета: свои по полям-оценкам; если своих нет — свёрнутые по детям. */
  function estimatesOf(row: Row & { rollup_estimates: string }): Estimate[] {
    const values = json<Record<string, unknown>>(row.field_values, {});
    const own = fieldsOf(row.type_id)
      .filter((field) => values[field.key] !== undefined && values[field.key] !== null && values[field.key] !== "")
      .map((field) => ({ scaleId: field.scaleId, value: values[field.key] as string | number }));
    if (own.length) return own;
    return Object.values(json<Record<string, ScaledRange>>(row.rollup_estimates, {})).map((range) => ({
      scaleId: range.scaleId,
      value: range.valueId ?? (range.min + range.max) / 2,
    }));
  }

  function compute(id: string, actor: HistoryActor, now: number): boolean {
    const row = select.get(id) as Row | undefined;
    if (!row) return false;
    const settings: RollupSettings = { ...DEFAULT_ROLLUPS, ...json<Partial<RollupSettings>>(row.rollups, {}) };
    // Баги по связи «вызывает» не входят в прогресс и свёртки (R-2.12), даже если их сделали детьми.
    const caused = new Set((causedBy.all(id) as { id: string }[]).map((row) => row.id));
    const children = (childRows.all(id) as (Row & { key: string })[]).filter((child) => !caused.has(child.id));
    const allScales = (scaleCache ??= scales.list(SYSTEM_VIEWER));
    let converter = converterCache.get(row.space_id);
    if (!converter) {
      converter = scales.converter(row.space_id);
      converterCache.set(row.space_id, converter);
    }
    const days = allScales.find((scale) => scale.key === DAYS_SCALE_KEY);
    const weight = (child: Row) => {
      if (!settings.progressByEstimate || !days) return null;
      const range = estimateIn(estimatesOf(child), days, allScales, converter);
      return range ? (range.min + range.max) / 2 : null;
    };

    // Пункт-ребёнок чеклиста отмечается сам по статусу ребёнка.
    const checklist = json<ChecklistItem[]>(row.checklist, []);
    const byKey = new Map(children.map((child) => [child.key, child]));
    let checklistChanged = false;
    const synced = checklist.map((item) => {
      const child = item.childKey ? byKey.get(item.childKey) : undefined;
      if (!child) return item;
      const done = child.category === "done";
      if (done !== item.done) checklistChanged = true;
      return { ...item, done };
    });

    const progress = computeProgress(
      settings.progress,
      settings.progressByEstimate,
      row.category,
      synced.map((item) => ({
        done: item.done,
        childId: item.childKey ? (byKey.get(item.childKey)?.id ?? null) : null,
      })),
      children.map((child) => ({
        id: child.id,
        category: child.category,
        outcome: child.outcome,
        weight: weight(child),
      })),
    );

    const dates = settings.dates
      ? datesRollup(
          children.map((child) => ({
            start: child.rollup_start ?? child.start_date,
            end: child.rollup_end ?? child.end_date,
          })),
        )
      : { start: null, end: null };

    const estimates: Record<string, ScaledRange> = {};
    if (settings.estimates && children.length) {
      for (const field of fieldsOf(row.type_id)) {
        const target = allScales.find((scale) => scale.id === field.scaleId);
        if (!target) continue;
        const { result } = rollupEstimates(
          children.map((child) => estimatesOf(child)),
          target,
          allScales,
          converter,
        );
        if (result) estimates[field.key] = result;
      }
    }

    let statusId = row.status_id;
    let category = row.category;
    let suggestClose = false;
    if (settings.status && children.length) {
      const decision = statusRollup(row.category, children);
      if (decision.action) {
        const target = inProgressStatus.get(row.type_id, row.space_id) as { id: string } | undefined;
        if (target) {
          statusId = target.id;
          category = "in_progress";
        }
      }
      suggestClose = decision.suggestClose && category !== "done";
    }

    const estimatesJson = JSON.stringify(estimates);
    const changed =
      (progress?.done ?? null) !== row.progress_done ||
      (progress?.total ?? null) !== row.progress_total ||
      (progress?.percent ?? null) !== row.progress_percent ||
      dates.start !== row.rollup_start ||
      dates.end !== row.rollup_end ||
      estimatesJson !== row.rollup_estimates ||
      Number(suggestClose) !== row.close_suggested ||
      checklistChanged;
    const statusChanged = statusId !== row.status_id;
    if (!changed && !statusChanged) return false;

    db.prepare(
      `UPDATE tickets SET progress_done = ?, progress_total = ?, progress_percent = ?, rollup_start = ?, rollup_end = ?,
         rollup_estimates = ?, close_suggested = ?, checklist = ? WHERE id = ?`,
    ).run(
      progress?.done ?? null,
      progress?.total ?? null,
      progress?.percent ?? null,
      dates.start,
      dates.end,
      estimatesJson,
      Number(suggestClose),
      JSON.stringify(synced),
      id,
    );
    if (statusChanged) {
      db.prepare(
        "UPDATE tickets SET status_id = ?, outcome = NULL, status_changed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
      ).run(statusId, now, now, id);
      history.record(
        id,
        actor,
        [
          { field: "status", from: history.statusValue(row.status_id), to: history.statusValue(statusId) },
          ...(row.outcome ? [{ field: "outcome", from: { raw: row.outcome, text: row.outcome }, to: null }] : []),
        ],
        now,
      );
    }
    return true;
  }

  return {
    /**
     * Пересчитывает тикеты и всех их предков снизу вверх. Возвращает тикеты, у которых что-то поменялось.
     * Одна транзакция с изменением: свёртка не отстаёт от правды ни на один запрос.
     */
    recompute(ids: readonly string[], actor: HistoryActor = ROLLUP_ACTOR): string[] {
      if (ids.length === 0) return [];
      const affected = [...new Set([...ids, ...tree.ancestors(ids)])];
      const order = tree.topo(affected).reverse();
      const now = Date.now();
      const changed: string[] = [];
      for (const id of order) if (compute(id, actor, now)) changed.push(id);
      fieldsCache.clear();
      scaleCache = null;
      converterCache.clear();
      return changed;
    },

    /** Пересчитать всё дерево типа (например, после смены настроек свёрток). */
    recomputeType(typeId: string) {
      const rows = db.prepare("SELECT id FROM tickets WHERE type_id = ?").all(typeId) as { id: string }[];
      return this.recompute(rows.map((row) => row.id));
    },

    /** Тикеты, у которых есть дети, среди данных (для массового пересчёта). */
    withChildren(ids: readonly string[]) {
      if (ids.length === 0) return [];
      return (
        db
          .prepare(`SELECT DISTINCT parent_id AS id FROM ticket_parents WHERE parent_id IN (${placeholders([...ids])})`)
          .all(...ids) as { id: string }[]
      ).map((row) => row.id);
    },
  };
}

export type RollupService = ReturnType<typeof rollupService>;
