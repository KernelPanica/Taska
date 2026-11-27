/** Журнал изменений тикета и комментарии (R-2.25; YT-07, docs/adr/0013). */
import type { PersonRef } from "./index.js";

/** Кто внёс изменение: человек, система, правило или помощник по запросу. */
export const HISTORY_SOURCES = ["person", "system", "rule", "assistant"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

/** Значение в журнале: как было сохранено и как его прочитать в момент изменения (имена — снимком). */
export interface HistoryValue {
  raw: unknown;
  text: string;
}

export interface HistoryEntry {
  id: number;
  at: string;
  /** Кто: ссылка на человека и его имя на момент изменения. */
  actor: PersonRef | null;
  actorName: string | null;
  source: HistorySource;
  sourceDetail: string | null;
  /**
   * Что изменилось: `created`, `title`, `description`, `checklist`, `status`, `outcome`, `type`, `priority`, `tags`,
   * `startDate`, `endDate`, `blocked`, `cancelReason`, `archived`, `people.<role>`, `values.<ключ поля>`.
   */
  field: string;
  /** Название поля типа на момент изменения (для `values.*`). */
  fieldLabel: string | null;
  from: HistoryValue | null;
  to: HistoryValue | null;
}

/** Отрезок последовательности статусов для метрик YourDash. */
export interface StatusPeriod {
  statusId: string;
  name: string;
  category: string;
  outcome: string | null;
  enteredAt: string;
  /** null — тикет всё ещё в этом статусе. */
  leftAt: string | null;
  actorName: string | null;
}

export interface CommentMentions {
  people: { login: string; id: string; name: string }[];
  tickets: { key: string; title: string; statusName: string | null }[];
}

export interface TicketComment {
  id: string;
  ticketId: string;
  author: PersonRef | null;
  authorName: string;
  /** Markdown; у удалённого — пусто. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  mentions: CommentMentions;
  /** Задача, сделанная из комментария, и её текущий статус. */
  createdTicket: { key: string; title: string; statusName: string | null; category: string | null } | null;
  canEdit: boolean;
  canDelete: boolean;
}
