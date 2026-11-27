/**
 * Иерархия (R-2.8, R-2.17; YT-09, docs/adr/0015) и свёртки (R-2.12; YT-10, docs/adr/0016).
 */
import type { PersonRef } from "./index.js";
import type { StatusCategory } from "./workflow.js";
import { CANCELLED_OUTCOME } from "./workflow.js";
import type { ProgressSource } from "./ticket-types.js";
import type { TicketLink } from "./links.js";
import type { ParentTrace } from "./trash.js";

/** Связанный тикет глазами зрителя. Недоступный — без ключа, названия и пространства (R-2.17). */
export type RelatedTicket =
  | {
      available: true;
      key: string;
      title: string;
      typeId: string;
      spaceId: string;
      spaceName: string;
      statusName: string;
      category: StatusCategory;
      outcome: string | null;
      assignees: PersonRef[];
      progress: Progress | null;
      /** Виден только заголовок (R-2.20). */
      titleOnly: boolean;
      /** Ребёнок, на которого ссылается пункт чеклиста. */
      inChecklist?: boolean;
      /** Номер в потоке на этой связи: у родителя — номер текущего тикета под ним, у ребёнка — номер ребёнка здесь. */
      number?: string;
    }
  | { available: false };

export interface TicketRelations {
  parents: RelatedTicket[];
  children: RelatedTicket[];
  /** Связи R-2.13 (кроме родителя и ребёнка), видны с обеих сторон (YT-12). */
  links: TicketLink[];
  /** Охват: сколько целей среди предков. */
  coverage: number;
  /** Следы удалённых родителей, к которым ребёнок ещё не привязан заново (YT-14). */
  traces: ParentTrace[];
}

export interface Progress {
  done: number;
  total: number;
  /** 0…100, округлено. */
  percent: number;
}

/** Узел дерева. Недоступный узел — без ключа и названия, только место в дереве. */
export interface TreeNode {
  id: string;
  available: boolean;
  key?: string;
  title?: string;
  typeId?: string;
  spaceId?: string;
  statusName?: string;
  category?: StatusCategory;
  titleOnly?: boolean;
  progress?: Progress | null;
  coverage?: number;
  /** Родителей больше одного: узел показывается под каждым с пометкой «тот же тикет». */
  parentCount: number;
  /** Номера в потоке по путям: parentId — id родителя в этом ответе (null у верхних). */
  numbers?: { number: string; parentId: string | null }[];
}

export interface TicketTree {
  nodes: Record<string, TreeNode>;
  roots: string[];
  children: Record<string, string[]>;
}

/** Быстрое создание «+ ребёнок» / «+ родитель» одной строкой (R-2.17). */
export interface QuickCreateInput {
  title: string;
  typeId: string;
  spaceId?: string;
}

/** «Обернуть в родителя»: новый тикет встаёт между тикетами и их общим родителем. */
export interface WrapInput {
  keys: string[];
  fromParentKey?: string | null;
  title: string;
  typeId: string;
  spaceId?: string;
}

/** Массовая смена родителя и перенос ветки одной операцией. */
export interface MoveInput {
  keys: string[];
  /** Какую связь заменить; без него — все текущие родители заменяются. */
  fromParentKey?: string | null;
  /** Новый родитель; null — без родителя (верхний уровень). */
  toParentKey: string | null;
  /** Поставить перед этим ребёнком нового родителя (порядок); без него — в конец.
   * С toParentKey = null — порядок верхних тикетов в пространстве. */
  beforeKey?: string | null;
}

// ---- Свёртки (R-2.12) ----

export interface RollupChild {
  id: string;
  category: StatusCategory;
  outcome: string | null;
  /** Вес по оценке (дни); null — оценки нет. */
  weight: number | null;
}

export interface RollupChecklistItem {
  done: boolean;
  /** Пункт-ссылка на ребёнка: отмечается сам, учитывается один раз. */
  childId?: string | null;
}

const cancelled = (child: Pick<RollupChild, "category" | "outcome">) =>
  child.category === "done" && child.outcome === CANCELLED_OUTCOME;

/**
 * Прогресс по источнику типа. Веса равные или по оценке; отменённые дети не входят;
 * ребёнок из чеклиста учитывается один раз (R-2.12).
 */
export function computeProgress(
  source: ProgressSource,
  byEstimate: boolean,
  category: StatusCategory,
  checklist: readonly RollupChecklistItem[],
  children: readonly RollupChild[],
): Progress | null {
  if (source === "none") return null;
  if (source === "status") {
    const percent = category === "done" ? 100 : category === "in_progress" ? 50 : 0;
    return { done: percent / 100, total: 1, percent };
  }
  const byId = new Map(children.map((child) => [child.id, child]));
  const units: { done: boolean; weight: number | null }[] = [];
  const counted = new Set<string>();
  const useChecklist = source === "checklist" || source === "both";
  const useChildren = source === "children" || source === "both";
  for (const item of useChecklist ? checklist : []) {
    if (item.childId) {
      const child = byId.get(item.childId);
      counted.add(item.childId);
      if (!child) {
        // Ребёнок отвязан — пункт живёт как обычный.
        units.push({ done: item.done, weight: null });
        continue;
      }
      if (cancelled(child)) continue;
      units.push({ done: child.category === "done", weight: child.weight });
    } else {
      units.push({ done: item.done, weight: null });
    }
  }
  if (useChildren) {
    for (const child of children) {
      if (counted.has(child.id) || cancelled(child)) continue;
      units.push({ done: child.category === "done", weight: child.weight });
    }
  }
  if (units.length === 0) return null;
  let total = 0;
  let done = 0;
  if (byEstimate) {
    const known = units.map((unit) => unit.weight).filter((weight): weight is number => weight !== null && weight > 0);
    // Без оценки — средний вес известных, чтобы пункт не обнулял и не перевешивал прогресс.
    const fallback = known.length ? known.reduce((sum, weight) => sum + weight, 0) / known.length : 1;
    for (const unit of units) {
      const weight = unit.weight !== null && unit.weight > 0 ? unit.weight : fallback;
      total += weight;
      if (unit.done) done += weight;
    }
  } else {
    total = units.length;
    done = units.filter((unit) => unit.done).length;
  }
  return { done: round(done), total: round(total), percent: Math.round((done / total) * 100) };
}

const round = (value: number) => Math.round(value * 100) / 100;

export type StatusRollupAction =
  /** Первый ребёнок в работе → родитель из очереди в работу. */
  | "start"
  /** Ребёнок вернулся в работу, а родитель закрыт → родитель тоже в работу. */
  | "reopen"
  | null;

/**
 * Свёртка статуса: что сделать с родителем и нужен ли флаг «все дети закрыты — закрыть?».
 * Отменённые дети не держат родителя открытым, но и не закрывают его сами по себе.
 */
export function statusRollup(
  parent: StatusCategory,
  children: readonly Pick<RollupChild, "category" | "outcome">[],
): { action: StatusRollupAction; suggestClose: boolean } {
  const active = children.filter((child) => !cancelled(child));
  const working = active.some((child) => child.category === "in_progress");
  const allDone = active.length > 0 && active.every((child) => child.category === "done");
  let action: StatusRollupAction = null;
  if (working && parent === "queue") action = "start";
  if (working && parent === "done") action = "reopen";
  const after = action ? "in_progress" : parent;
  return { action, suggestClose: allDone && after !== "done" };
}

/** Свёртка дат: самое раннее начало и самый поздний конец детей. */
export function datesRollup(children: readonly { start: string | null; end: string | null }[]) {
  let start: string | null = null;
  let end: string | null = null;
  for (const child of children) {
    if (child.start && (!start || child.start < start)) start = child.start;
    if (child.end && (!end || child.end > end)) end = child.end;
  }
  return { start, end };
}
