/** Тикет (R-2.5, R-2.6, R-2.10, R-2.11; YT-06, docs/adr/0012). */
import type { PersonRef } from "./index.js";
import type { FieldValue } from "./ticket-types.js";
import type { ScaledRange } from "./estimates.js";
import type { TicketPermissions, TicketVisibility } from "./access.js";
import type { Progress, TicketRelations } from "./hierarchy.js";

export const PRIORITIES = ["highest", "high", "normal", "low", "lowest"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Архив — признак с причиной, а не статус (R-2.11). */
export const ARCHIVE_REASONS = ["done", "postponed", "unmarked"] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** Пункт-ребёнок: ключ ребёнка; отмечается сам, когда ребёнок закрыт (R-2.12). */
  childKey?: string | null;
}

/** Что родитель знает по детям (R-2.12). */
export interface TicketRollup {
  progress: Progress | null;
  /** Даты по детям; ручные даты — startDate/endDate тикета. */
  startDate: string | null;
  endDate: string | null;
  /** Ручные даты расходятся со свёрткой. */
  datesDiffer: boolean;
  /** Сумма оценок детей по полям-оценкам типа. */
  estimates: Record<string, ScaledRange>;
  /** «Все дети закрыты — закрыть?»: закрывает человек. */
  closeSuggested: boolean;
}

export interface TicketPeople {
  assignees: PersonRef[];
  customer: PersonRef | null;
  tester: PersonRef | null;
  watchers: PersonRef[];
}

export interface Ticket {
  id: string;
  /** Ключ AOS-N: сквозной, не меняется, не переиспользуется (R-2.6). */
  key: string;
  number: number;
  spaceId: string;
  typeId: string;
  statusId: string;
  outcome: string | null;
  title: string;
  description: string;
  checklist: ChecklistItem[];
  /** Значения полей типа по системному имени. */
  values: Record<string, FieldValue>;
  priority: Priority;
  tags: string[];
  startDate: string | null;
  endDate: string | null;
  blocked: boolean;
  blockedReason: string | null;
  cancelReason: string | null;
  archived: { reason: ArchiveReason; at: string } | null;
  /** Старый номер Taiga («General #57»): только чтение, заполняет импорт (YT-29); ищется TQL legacyNumber. */
  legacyNumber: string | null;
  people: TicketPeople;
  /** Версия для защиты от параллельных правок (R-3.1). */
  version: number;
  createdBy: PersonRef | null;
  updatedBy: PersonRef | null;
  createdAt: string;
  updatedAt: string;
  /** Номера в потоке (R-2.9): по одному на путь от верхнего предка; parentKey — прямой родитель на пути. */
  numbers: FlowNumberView[];
  visibility: TicketVisibility;
  permissions: TicketPermissions;
  /** Поля типа, скрытые маской от зрителя (R-2.20): интерфейс их не показывает и не отправляет. */
  masked: string[];
  relations: TicketRelations;
  rollup: TicketRollup;
}

/** Номер в потоке для показа: «№ 1.3 в AOS-201». Недоступный родитель — без ключа (R-2.17). */
export interface FlowNumberView {
  number: string;
  parentKey: string | null;
}

/** Ответ на запрос содержимого тикета «только заголовок»: что можно показать постороннему. */
export interface TitleOnlyTicket {
  key: string;
  title: string;
  typeId: string;
  progress: Progress | null;
}

export interface TicketSummary {
  id: string;
  key: string;
  title: string;
  typeId: string;
  statusId: string;
  outcome: string | null;
  priority: Priority;
  assignees: PersonRef[];
  blocked: boolean;
  archived: boolean;
  updatedAt: string;
  /** Посторонний видит только название и прогресс (R-2.20). */
  titleOnly: boolean;
  progress: Progress | null;
  /** Охват: сколько целей среди предков (R-2.8). */
  coverage: number;
  /** Номера в потоке (R-2.9). */
  numbers: string[];
}

export interface TicketCreateInput {
  spaceId: string;
  typeId: string;
  title: string;
  templateId?: string;
  /** Создать сразу ребёнком этого тикета («+ ребёнок», R-2.17). */
  parentKey?: string;
  /** Создать сразу родителем этого тикета («+ родитель»). */
  childKey?: string;
  /** С parentKey: встать перед этим ребёнком (вставка в середину потока, R-2.9); без него — в конец. */
  beforeKey?: string;
}

export interface TicketPatch {
  version: number;
  title?: string;
  description?: string;
  checklist?: ChecklistItem[];
  values?: Record<string, FieldValue>;
  priority?: Priority;
  tags?: string[];
  startDate?: string | null;
  endDate?: string | null;
  blocked?: boolean;
  blockedReason?: string | null;
  people?: { assigneeIds?: string[]; customerId?: string | null; testerId?: string | null; watcherIds?: string[] };
}
