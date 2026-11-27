import type { PersonRef, Priority, Progress } from "./index.js";
import { STARTER_ZONES } from "./tql.js";

/**
 * Доски (R-2.18) и зоны (R-2.19), docs/adr/0022.
 * Доска = базовый фильтр TQL + раскладка + чипы; тикеты не хранит. Отдельных «видов» нет.
 */
export const BOARD_LANES = ["none", "parent", "team", "stream", "assignee", "tags"] as const;
/** Дорожки по родителю, исполнителю, тегам или любому измерению (R-2.14): «field:<системное имя поля>». */
export type BoardLanes = (typeof BOARD_LANES)[number] | `field:${string}`;
export const isBoardLanes = (value: string): value is BoardLanes =>
  (BOARD_LANES as readonly string[]).includes(value) || /^field:[a-z][a-z0-9_]{1,39}$/.test(value);
export const BOARD_SORTS = ["due", "priority", "manual"] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];
export const CARD_DENSITIES = ["compact", "normal", "detailed"] as const;
export type CardDensity = (typeof CARD_DENSITIES)[number];
export const BOARD_CHIPS = ["type", "stream", "team", "assignee", "tags"] as const;
/** Чипы по типу, стриму, команде, исполнителю, тегам или любому измерению: «field:<ключ>». */
export type BoardChip = (typeof BOARD_CHIPS)[number] | `field:${string}`;
export const isBoardChip = (value: string): value is BoardChip =>
  (BOARD_CHIPS as readonly string[]).includes(value) || /^field:[a-z][a-z0-9_]{1,39}$/.test(value);
/** Значение чипа «Без …»: карточки без значения измерения. */
export const CHIP_NONE = "__none";

/** Именованный фильтр TQL: дорожка («Срочно»: priority = Urgent) или чип («Только люди колодца ГД»). */
export interface BoardFilter {
  id: string;
  name: string;
  query: string;
}
export const DETAIL_LEVELS = [1, 2, 3] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Зона — колонка доски: один или несколько статусов разных типов (по имени статуса). */
export interface BoardZone {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  statuses: string[];
  /** WIP-лимит на зону любого уровня (R-2.19, R-2.21); null — без лимита. */
  wipLimit: number | null;
}

export type BoardOwner =
  | { kind: "space"; spaceId: string; spaceName: string; spaceSlug: string }
  | { kind: "person"; userId: string };

export interface BoardSummary {
  id: string;
  name: string;
  /** «mine» — стартовая личная «Мои задачи»; её нельзя удалить. */
  kind: "custom" | "mine";
  owner: BoardOwner;
  query: string;
  canEdit: boolean;
}

export interface Board extends BoardSummary {
  lanes: BoardLanes;
  sort: BoardSort;
  /** Завершённые старше стольких дней скрыты с доски (R-2.11). */
  doneDays: number;
  chips: BoardChip[];
  /** Дорожки по фильтрам TQL — всегда сверху; подходящая карточка уходит в первую такую дорожку. */
  tqlLanes: BoardFilter[];
  /** Чипы-фильтры TQL: включённый оставляет только подходящие карточки. */
  tqlChips: BoardFilter[];
  zones: BoardZone[];
}

export interface BoardInput {
  name: string;
  query: string;
  /** null — личная доска. */
  spaceId: string | null;
  lanes?: BoardLanes;
  sort?: BoardSort;
  doneDays?: number;
  chips?: BoardChip[];
  tqlLanes?: BoardFilter[];
  tqlChips?: BoardFilter[];
}

export type BoardPatch = Partial<Omit<BoardInput, "spaceId">>;

export interface BoardZoneInput {
  id: string;
  name: string;
  parentId: string | null;
  statuses: string[];
  wipLimit?: number | null;
}

/** Личные настройки доски: у других доска не меняется (R-2.19). */
export interface BoardPrefs {
  detail: DetailLevel;
  /** Свёрнутые зоны. */
  collapsed: string[];
  /** Скрытые уровни шапки. */
  hiddenLevels: number[];
  density: CardDensity;
  /** Выключенные чипы: «type:<id>», «stream:<id>», «team:<id>». */
  chipsOff: string[];
  /** Своя раскладка дорожек поверх раскладки доски; null — как у доски. */
  lanes: BoardLanes | null;
  /** Свёрнутые дорожки. */
  lanesCollapsed: string[];
  /** Включённые чипы-фильтры TQL (id из tqlChips). */
  tqlOn: string[];
}

export const DEFAULT_BOARD_PREFS: BoardPrefs = {
  detail: 2,
  collapsed: [],
  hiddenLevels: [],
  density: "normal",
  chipsOff: [],
  lanes: null,
  lanesCollapsed: [],
  tqlOn: [],
};

export interface BoardStatusOption {
  id: string;
  name: string;
  category: "queue" | "in_progress" | "done";
  waiting: boolean;
  outcomes: string[];
}

/** Карточка доски (R-2.18): минимум — ключ, номер в потоке, название, тип, стрим, исполнитель, точный статус, срок. */
export interface BoardCard {
  id: string;
  key: string;
  title: string;
  typeId: string;
  spaceId: string;
  statusId: string;
  statusName: string;
  category: BoardStatusOption["category"];
  waiting: boolean;
  outcome: string | null;
  /** Ключ схемы в `schemes`: тип + пространство. */
  scheme: string;
  version: number;
  priority: Priority;
  assignees: PersonRef[];
  numbers: string[];
  due: string | null;
  overdue: boolean;
  team: { id: string; name: string } | null;
  streams: { id: string; name: string }[];
  /** Родители для дорожек; недоступный родитель — без ключа и названия (R-2.17). */
  parents: { id: string; key: string | null; title: string | null }[];
  progress: Progress | null;
  blocked: boolean;
  tags: string[];
  /** Значения своих измерений (R-2.14) по системному имени поля; команда и стрим — отдельно. */
  dims: Record<string, { id: string; name: string }[]>;
  /** Ручной порядок; null — карточку ещё не двигали. */
  rank: number | null;
  /** Может ли зритель менять статус. */
  canMove: boolean;
}

export interface BoardView {
  board: Board;
  prefs: BoardPrefs;
  cards: BoardCard[];
  schemes: Record<string, BoardStatusOption[]>;
  /** Сколько завершённых скрыто по сроку doneDays. */
  hiddenDone: number;
  /** Свои измерения в тикетах доски — для дорожек и чипов. */
  dimensions: { key: string; name: string }[];
  /** Какие карточки подходят под каждую дорожку-фильтр и чип-фильтр TQL (id тикетов), в пределах прав зрителя. */
  laneHits: Record<string, string[]>;
  chipHits: Record<string, string[]>;
  /** Уточнение фильтра из адреса (?q=) — применено поверх фильтра доски; null — нет. */
  refine: string | null;
  tookMs: number;
}

export interface BoardMoveInput {
  key: string;
  version: number;
  zoneId: string;
  /** Нужен, когда в зоне несколько статусов для типа карточки. */
  statusId?: string;
  outcome?: string;
  /** Новый порядок ключей колонки (ручная сортировка). */
  order?: string[];
}

export interface BoardCreateTicketInput {
  typeId: string;
  title: string;
  spaceId?: string;
}

/** Стартовое дерево зон R-5.1. */
export function starterZones(): BoardZone[] {
  return STARTER_ZONES.map((zone, index) => ({
    id: zone.key,
    name: zone.name,
    parentId: zone.parent,
    position: index,
    statuses: [...zone.statuses],
    wipLimit: null,
  }));
}

const childrenOf = (zones: readonly BoardZone[], parentId: string | null) =>
  zones.filter((zone) => zone.parentId === parentId).sort((a, b) => a.position - b.position);

/** Статусы зоны со всеми подзонами. */
export function zoneStatusNames(zones: readonly BoardZone[], zoneId: string): string[] {
  const zone = zones.find((item) => item.id === zoneId);
  if (!zone) return [];
  const result = new Set(zone.statuses);
  for (const child of childrenOf(zones, zone.id)) zoneStatusNames(zones, child.id).forEach((name) => result.add(name));
  return [...result];
}

/** Все статусы, у которых есть зона. */
export function mappedStatuses(zones: readonly BoardZone[]): Set<string> {
  return new Set(zones.flatMap((zone) => zone.statuses));
}

export const UNMAPPED_ZONE = "__unmapped";

export interface BoardColumn {
  id: string;
  /** Зона колонки (для колонки-статуса — его зона). */
  zoneId: string;
  /** Колонка-статус (детализация до статусов). */
  status: string | null;
  name: string;
  statuses: string[];
}

export interface BoardHeaderCell {
  id: string;
  zoneId: string;
  status: string | null;
  name: string;
  level: number;
  /** 1-based строка и колонка сетки шапки. */
  row: number;
  rowSpan: number;
  col: number;
  colSpan: number;
  statuses: string[];
  wipLimit: number | null;
  /** Зону можно свернуть или развернуть. */
  expandable: boolean;
  collapsed: boolean;
}

export interface BoardLayout {
  columns: BoardColumn[];
  cells: BoardHeaderCell[];
  rows: number;
  /** Уровни шапки, что есть у этой доски при этой детализации. */
  levels: number[];
  /** Статусы без зоны — служебная колонка «Не сопоставлено» (R-2.19). */
  unmapped: string[];
}

/**
 * Шапка и колонки доски по дереву зон, детализации, свёрнутым зонам и скрытым уровням.
 * Уровень 1 — корни дерева; детализация N раскрывает зоны до уровня N, лист-зона из нескольких
 * статусов на следующем уровне делится на колонки-статусы. Свёрнутая зона — одна колонка.
 * Скрытый уровень убирает строку шапки, колонки не меняются.
 */
export function boardLayout(
  zones: readonly BoardZone[],
  view: Pick<BoardPrefs, "detail" | "collapsed" | "hiddenLevels">,
  presentStatuses: readonly string[] = [],
): BoardLayout {
  const collapsed = new Set(view.collapsed);
  const columns: BoardColumn[] = [];
  type Raw = Omit<BoardHeaderCell, "row" | "rowSpan"> & { leaf: boolean };
  const raw: Raw[] = [];

  const walk = (zone: BoardZone, level: number) => {
    const start = columns.length;
    const kids = childrenOf(zones, zone.id);
    const all = zoneStatusNames(zones, zone.id);
    const canExpand = kids.length > 0 || zone.statuses.length > 1;
    const open = canExpand && !collapsed.has(zone.id) && level < view.detail;
    if (open && kids.length) {
      if (zone.statuses.length) {
        columns.push({ id: `${zone.id}:own`, zoneId: zone.id, status: null, name: zone.name, statuses: zone.statuses });
      }
      for (const kid of kids) walk(kid, level + 1);
    } else if (open) {
      for (const status of zone.statuses) {
        raw.push({
          id: `${zone.id}:${status}`,
          zoneId: zone.id,
          status,
          name: status,
          level: level + 1,
          col: columns.length + 1,
          colSpan: 1,
          statuses: [status],
          wipLimit: null,
          expandable: false,
          collapsed: false,
          leaf: true,
        });
        columns.push({ id: `${zone.id}:${status}`, zoneId: zone.id, status, name: status, statuses: [status] });
      }
    } else {
      columns.push({ id: zone.id, zoneId: zone.id, status: null, name: zone.name, statuses: all });
    }
    raw.push({
      id: zone.id,
      zoneId: zone.id,
      status: null,
      name: zone.name,
      level,
      col: start + 1,
      colSpan: Math.max(1, columns.length - start),
      statuses: all,
      wipLimit: zone.wipLimit,
      expandable: canExpand,
      collapsed: canExpand && !open,
      leaf: !open,
    });
  };
  for (const root of childrenOf(zones, null)) walk(root, 1);

  const mapped = mappedStatuses(zones);
  const unmapped = [...new Set(presentStatuses.filter((name) => !mapped.has(name)))];
  const maxLevel = Math.max(1, ...raw.map((cell) => cell.level));
  const levels = Array.from({ length: maxLevel }, (_, index) => index + 1);
  let visible = levels.filter((level) => !view.hiddenLevels.includes(level));
  if (!visible.length) visible = [maxLevel];
  const rowOf = (level: number) => {
    const index = visible.findIndex((item) => item >= level);
    return index < 0 ? visible.length : index + 1;
  };
  const cells: BoardHeaderCell[] = [];
  for (const cell of raw) {
    const { leaf, ...rest } = cell;
    if (!leaf && !visible.includes(cell.level)) continue;
    const row = rowOf(cell.level);
    cells.push({ ...rest, row, rowSpan: leaf ? visible.length - row + 1 : 1 });
  }
  if (unmapped.length) {
    columns.push({ id: UNMAPPED_ZONE, zoneId: UNMAPPED_ZONE, status: null, name: "", statuses: unmapped });
    cells.push({
      id: UNMAPPED_ZONE,
      zoneId: UNMAPPED_ZONE,
      status: null,
      name: "",
      level: 1,
      row: 1,
      rowSpan: visible.length,
      col: columns.length,
      colSpan: 1,
      statuses: unmapped,
      wipLimit: null,
      expandable: false,
      collapsed: false,
    });
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  return { columns, cells, rows: visible.length, levels, unmapped };
}

/** Статусы схемы карточки, в которые её можно бросить в эту колонку; пусто — тип проходит зону насквозь. */
export function dropOptions(column: Pick<BoardColumn, "statuses">, scheme: readonly BoardStatusOption[]) {
  const names = new Set(column.statuses);
  return scheme.filter((status) => names.has(status.name));
}

/** Порядок карточек в колонке: вручную (ранг, затем срок), по сроку (ранний выше) или по приоритету. */
const PRIORITY_RANK: Record<Priority, number> = { highest: 0, high: 1, normal: 2, low: 3, lowest: 4 };
export function compareCards(sort: BoardSort) {
  const byDue = (a: BoardCard, b: BoardCard) =>
    (a.due ?? "9999") < (b.due ?? "9999") ? -1 : (a.due ?? "9999") > (b.due ?? "9999") ? 1 : 0;
  const byNumber = (a: BoardCard, b: BoardCard) =>
    Number(a.key.replace(/\D+/g, "")) - Number(b.key.replace(/\D+/g, ""));
  return (a: BoardCard, b: BoardCard) => {
    if (sort === "manual") {
      const ra = a.rank ?? Number.POSITIVE_INFINITY;
      const rb = b.rank ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra < rb ? -1 : 1;
    }
    if (sort === "priority") {
      const diff = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
      if (diff) return diff;
    }
    return byDue(a, b) || byNumber(a, b);
  };
}

/** WIP: карточки в работе без признака «ожидание» (R-2.10), каждая один раз. */
export function wipCount(cards: readonly BoardCard[], statuses: readonly string[]) {
  const names = new Set(statuses);
  return new Set(
    cards
      .filter((card) => names.has(card.statusName) && card.category === "in_progress" && !card.waiting)
      .map((card) => card.id),
  ).size;
}
