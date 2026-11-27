import type { Outcome } from "./workflow.js";

/**
 * Конструктор типов тикетов, полей, шаблонов и шкал оценки (R-2.5, R-2.7, R-2.26; YT-04, docs/adr/0010).
 */

export const FIELD_KINDS = ["text", "number", "date", "list", "person", "estimate", "dimension"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Системное имя поля — латиница для TQL: с буквы, строчные буквы, цифры и `_`. */
export const FIELD_KEY_PATTERN = "^[a-z][a-z0-9_]{1,39}$";

/** Имена, занятые встроенными атрибутами тикета в TQL (R-2.15, YT-15). */
export const RESERVED_FIELD_KEYS = [
  "key",
  "type",
  "status",
  "category",
  "outcome",
  "title",
  "description",
  "checklist",
  "space",
  "parent",
  "child",
  "children",
  "created",
  "updated",
  "creator",
  "reporter",
  "watcher",
  "comment",
  "text",
  "tag",
  "tags",
  "link",
  "links",
  "archived",
  "legacy",
  "order",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "empty",
] as const;

/** Набор иконок типов (Phosphor). Хранится имя, рисует клиент. */
export const TYPE_ICONS = [
  "target",
  "lightning",
  "book-open",
  "check-square",
  "bug",
  "megaphone",
  "flag",
  "flag-banner",
  "diamond",
  "star",
  "rocket",
  "wrench",
  "palette",
  "film",
  "music-note",
  "code",
  "game-controller",
  "calendar",
  "question",
  "cube",
] as const;
export type TypeIcon = (typeof TYPE_ICONS)[number];

export const COLOR_PATTERN = "^#[0-9a-fA-F]{6}$";

export interface ListOption {
  id: string;
  label: string;
}

/** Поле тикета. Настройки зависят от вида. */
export interface TicketField {
  id: string;
  key: string;
  name: string;
  kind: FieldKind;
  /** Для «списка». */
  options: ListOption[];
  multiple: boolean;
  /** Для «шкалы оценки». */
  scaleId: string | null;
  /** Для «измерения». */
  dimensionId: string | null;
  system: boolean;
}

export interface TicketFieldInput {
  name: string;
  key?: string;
  kind: FieldKind;
  options?: string[];
  multiple?: boolean;
  scaleId?: string | null;
  dimensionId?: string | null;
}

export const PROGRESS_SOURCES = ["children", "checklist", "both", "status", "none"] as const;
export type ProgressSource = (typeof PROGRESS_SOURCES)[number];

/** Настройки свёрток типа (R-2.12). Здесь только хранение; считает YT-10. */
export interface RollupSettings {
  status: boolean;
  progress: ProgressSource;
  progressByEstimate: boolean;
  dates: boolean;
  estimates: boolean;
}

export const DEFAULT_ROLLUPS: RollupSettings = {
  status: false,
  progress: "checklist",
  progressByEstimate: false,
  dates: false,
  estimates: false,
};

export interface TemplateSummary {
  id: string;
  name: string;
}

export interface TicketType {
  id: string;
  key: string;
  name: string;
  color: string;
  icon: TypeIcon;
  /** Поля в порядке показа в карточке. */
  fieldIds: string[];
  rollups: RollupSettings;
  /**
   * Ограничитель подчинения: какие типы могут быть родителем. Пусто — любой.
   * Действует только в пространствах, где ограничители включены (выключены по умолчанию).
   */
  allowedParentTypeIds: string[];
  templates: TemplateSummary[];
  /** Исходы завершённых статусов (R-2.10); «отменено» есть всегда. */
  outcomes: Outcome[];
  system: boolean;
}

export interface TicketTypeInput {
  name: string;
  key?: string;
  color: string;
  icon: TypeIcon;
  fieldIds?: string[];
  rollups?: Partial<RollupSettings>;
  allowedParentTypeIds?: string[];
  outcomes?: Outcome[];
}

/** Значение поля в шаблоне (и позже в тикете), по системному имени поля. */
export type FieldValue = string | number | string[] | null;

export interface TicketTemplate {
  id: string;
  typeId: string;
  name: string;
  /** Структура описания, Markdown. */
  description: string;
  checklist: string[];
  values: Record<string, FieldValue>;
  system: boolean;
}

export interface TicketTemplateInput {
  name: string;
  description?: string;
  checklist?: string[];
  values?: Record<string, FieldValue>;
}
