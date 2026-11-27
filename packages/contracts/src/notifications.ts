import type { PersonRef } from "./index.js";

/**
 * Уведомления (R-2.27), docs/adr/0024. Каналы: колокольчик и очередь событий; почта и Telegram подключатся
 * к очереди позже. Правила группировки одинаковы для всех каналов: одно сообщение на пакет и получателя.
 */
export const NOTIFICATION_KINDS = [
  "assigned",
  "mentioned",
  "status_changed",
  "commented",
  "team_ticket_trashed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Тикет в уведомлении глазами читателя: недоступный — без ключа и названия (R-2.17, R-2.20). */
export interface NotificationTicket {
  id: string;
  key: string | null;
  title: string | null;
  available: boolean;
}

/** Одно событие внутри уведомления: смена статуса «откуда → куда», отрывок комментария. */
export interface NotificationEntry {
  ticket: NotificationTicket;
  from: string | null;
  to: string | null;
  /** Отрывок комментария; только если читателю открыто содержимое тикета. */
  excerpt: string | null;
  commentId: string | null;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  actor: PersonRef | null;
  /** Уникальные тикеты уведомления (для ссылок и счётчика). */
  tickets: NotificationTicket[];
  entries: NotificationEntry[];
  /** Пакет: одно сообщение на массовую операцию (R-2.27). */
  batch: boolean;
  /** Живая запись: обновляется на месте, пока не прочитана. */
  live: boolean;
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
  read: boolean;
}

export interface NotificationSetting {
  kind: NotificationKind;
  enabled: boolean;
}

/** Массовая правка (R-3.1: атомарно): статус по имени — у каждого типа свой id статуса. */
export interface BulkEditInput {
  keys: string[];
  status?: string;
  outcome?: string;
  priority?: "highest" | "high" | "normal" | "low" | "lowest";
  assigneeIds?: string[];
  watcherIds?: string[];
}
