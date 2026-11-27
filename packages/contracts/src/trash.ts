/**
 * Корзина, след родителя и пересвязка (R-2.8, R-2.22, R-5.2; YT-14, docs/adr/0020).
 */
import type { PersonRef } from "./index.js";

/**
 * Что делать с детьми удаляемого родителя (R-2.8):
 * keep — оставить без этой связи (по умолчанию); relink — к другому или новому родителю;
 * grandparent — к родителю удаляемого; delete — удалить вместе с ним.
 */
export const CHILDREN_MODES = ["keep", "relink", "grandparent", "delete"] as const;
export type ChildrenMode = (typeof CHILDREN_MODES)[number];

export interface TrashInput {
  keys: string[];
  /** Обязателен, если у удаляемых есть дети вне выделения: иначе 409 children_choice_required. */
  children?: ChildrenMode;
  /** relink: ключ другого родителя… */
  targetKey?: string;
  /** …или новый родитель того же типа и пространства, что первый удаляемый. */
  newParentTitle?: string;
  /** Массовое удаление (больше одного тикета) подтверждается: иначе 409 bulk_confirm_required. */
  confirm?: boolean;
}

/** Тикет в ответах корзины: ключ и название — их видно даже после очистки. */
export interface TrashTicketRef {
  key: string;
  title: string;
}

export interface TrashResult {
  /** Пакет для «Отменить»: восстанавливает всё удалённое этим действием и снимает связи, которые оно создало. */
  batchId: string;
  deleted: TrashTicketRef[];
  /** Дети, оставшиеся без связи или привязанные к другому родителю; у каждого — след. */
  children: TrashTicketRef[];
  /** Кому ушло уведомление (ПМ команды при удалении лидом). */
  notified: PersonRef[];
}

/** 409 children_choice_required: дети, о которых нужно спросить. */
export interface ChildrenChoice {
  children: TrashTicketRef[];
  /** Есть ли у удаляемых родители — для варианта «к родителю удаляемого». */
  hasGrandparents: boolean;
}

export interface TrashItem {
  key: string;
  title: string;
  typeId: string;
  spaceId: string;
  spaceName: string;
  deletedAt: string;
  deletedBy: PersonRef | null;
  batchId: string;
  /** Когда системное правило очистит его окончательно. */
  purgeAt: string;
  /** Сколько связей вернётся при восстановлении (вторая сторона жива). */
  relations: number;
  canRestore: boolean;
  canPurge: boolean;
}

export interface RestoreInput {
  keys?: string[];
  batchId?: string;
}

export interface RestoreResult {
  restored: TrashTicketRef[];
  /** Связи, которые не вернулись: вторая сторона удалена или связь нарушила бы правила дерева. */
  skipped: { key: string; reason: "deleted" | "purged" | "cycle" | "rules" }[];
}

export interface PurgeInput {
  keys: string[];
}

export interface TrashSettings {
  /** Сколько дней удалённое лежит в корзине до очистки (по умолчанию квартал). */
  retentionDays: number;
  lastPurgeAt: string | null;
  /** Право досрочной очистки — только у суперадмина (R-5.2). */
  canPurge: boolean;
}

/** След родителя у ребёнка (R-2.8): ключ и название остаются навсегда, даже после очистки корзины. */
export interface ParentTrace {
  id: string;
  parentKey: string;
  parentTitle: string;
  /** trash — родитель в корзине; purged — очищен окончательно. */
  parentState: "trash" | "purged";
  removedAt: string;
  removedBy: PersonRef | null;
  /** Сколько ещё бывших детей с этим следом и без новой связи. */
  others: number;
}

/** «Связать заново»: всех бывших детей родителя — к новому или восстановленному родителю. */
export interface RelinkInput {
  parentKey: string;
  /** Новый родитель; без него — сам бывший родитель (после восстановления). */
  toKey?: string;
}

export interface RelinkResult {
  relinked: TrashTicketRef[];
  /** Дети, которых зритель не может перемещать или которые нарушили бы правила дерева. */
  skipped: { key: string; reason: "forbidden" | "cycle" | "rules" }[];
}

/** Запрос parentTrace(AOS-199): бывшие дети родителя по следу (функция TQL R-2.28 / R-5.3). */
export const PARENT_TRACE_QUERY = /^\s*parentTrace\(\s*([A-Za-z][A-Za-z0-9]*-\d+)\s*\)\s*$/;
export const parentTraceKey = (query: string | undefined | null) =>
  query ? (PARENT_TRACE_QUERY.exec(query)?.[1]?.toUpperCase() ?? null) : null;

/** Колокольчик (R-2.27). Пока одно событие YT-14: лид удалил тикеты команды — одно сообщение на пакет. */
