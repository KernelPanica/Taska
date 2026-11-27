import type { Lens, Right } from "./access.js";
/**
 * Общие контракты API YourTask. Используются сервером, веб-интерфейсом,
 * а позже — помощником и мобильным приложением (см. docs/adr/0004).
 */

export const LOCALES = ["ru", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ru";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Заголовок, которым клиент подтверждает изменяющие запросы (CSRF). */
export const CSRF_HEADER = "x-yourtask-csrf";

/**
 * Единый формат ошибки API — RFC 9457 «Problem Details» с машинным кодом.
 * Клиенты переводят ошибку по `code`, а не по `title`/`detail`.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  requestId: string;
  errors?: ProblemFieldError[];
  /** version_conflict: актуальное состояние объекта (R-3.1). */
  current?: unknown;
  /** status_choice_required: id статусов, из которых нужно выбрать. */
  candidates?: string[];
  /** ticket_title_only: что можно показать постороннему — ключ, название, прогресс (R-2.20). */
  ticket?: unknown;
  /** children_choice_required: дети удаляемых и есть ли у них дедушки (R-2.8). */
  choice?: unknown;
  /** bulk_confirm_required: сколько тикетов будет удалено. */
  count?: number;
  /** tql_invalid: где ошибка в запросе и что подсказать (R-2.28). */
  tql?: unknown;
}

export interface ProblemFieldError {
  field: string;
  message: string;
}

export const ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthenticated",
  "csrf_invalid",
  "forbidden",
  "mfa_required",
  "not_found",
  "conflict",
  "rate_limited",
  "login_failed",
  "login_expired",
  "account_conflict",
  "account_deactivated",
  "catalog_unavailable",
  "version_conflict",
  "transition_blocked",
  "status_choice_required",
  "ticket_title_only",
  "hierarchy_cycle",
  "subordination_violation",
  "view_as_read_only",
  "link_exists",
  "integration_unavailable",
  "upload_refused",
  "file_type_mismatch",
  "children_choice_required",
  "bulk_confirm_required",
  "ticket_in_trash",
  "ticket_purged",
  "tql_invalid",
  "zone_not_for_type",
  "identity_provider_error",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type UserRole = "superadmin" | "member";
export type LoginMethod = "password" | "google";

export interface User {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  locale: Locale;
}

export interface Me {
  user: User;
  csrfToken: string;
  session: { id: string; method: LoginMethod; mfa: boolean; expiresAt: string };
  /** «Смотреть как» или «Режим показа»: API отвечает глазами выбранной роли или человека (R-2.20). */
  lens: Lens | null;
  /** Роль «Режима показа», выбранная один раз и запомненная. */
  showProfileId: string | null;
  /** Может ли смотреть глазами конкретного человека (суперадмин). */
  canViewAsPerson: boolean;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  method: LoginMethod;
  mfa: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export type SpaceRole = "owner" | "member";

export interface Space {
  id: string;
  slug: string;
  name: string;
  /** Роль текущего пользователя; null — не участник (суперадмин видит все пространства). */
  role: SpaceRole | null;
  /** Права зрителя в пространстве хотя бы в части тикетов (R-2.20): для кнопок интерфейса. */
  rights: Right[];
  /** Ограничители подчинения типов действуют в этом пространстве (R-2.7); по умолчанию выключены. */
  enforceSubordination: boolean;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
}

/** Краткая ссылка на человека в составах, лидах и ПМах. */
export interface PersonRef {
  id: string;
  name: string;
  email: string | null;
  /** Деактивирован в каталоге YourSpace: вход закрыт, имя остаётся в истории (R-2.2). */
  deactivated: boolean;
}

export interface GroupRef {
  id: string;
  name: string;
}

export const MEMBERSHIP_STATUSES = ["active", "paused", "left"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * Данные профиля из общего каталога YourSpace (R-2.2). В YourTask только показываются.
 * Чувствительные поля приходят и хранятся только маской: телефон «+… 42», остальное «…» (R-2.2, R-3.2).
 */
export interface CatalogProfile {
  username: string;
  fullName: string | null;
  nickname: string | null;
  telegram: string | null;
  vk: string | null;
  city: string | null;
  timezone: string | null;
  portfolio: string | null;
  roleTitle: string | null;
  membershipStatus: MembershipStatus | null;
  joinedAt: string | null;
  tenure: string | null;
  availabilityHours: number | null;
  giteaLogin: string | null;
  perforceLogin: string | null;
  /** Маски чувствительных полей; null — поле не заполнено. */
  masked: {
    phone: string | null;
    extraEmail: string | null;
    birthDate: string | null;
    comments: string | null;
    unavailabilityRisk: string | null;
  };
  /** Профиль в YourSpace: там его правят и там сам человек и суперадмин видят поля без маски. */
  profileUrl: string;
  syncedAt: string;
}

/** Карточка человека (R-2.15): данные каталога + то, что ведёт YourTask. */
export interface Person {
  id: string;
  name: string;
  email: string | null;
  locale: Locale;
  role: UserRole;
  /** Личная норма WIP; логика нормы — YT-19. */
  wipLimit: number | null;
  /** Есть в каталоге YourSpace (связан с аккаунтом). */
  linked: boolean;
  deactivated: boolean;
  deactivatedAt: string | null;
  guilds: GroupRef[];
  teams: GroupRef[];
  catalog: CatalogProfile | null;
}

/** Что ведёт YourTask (R-2.2): язык, норма WIP, колодцы и фичекоманды. */
export interface PersonInput {
  locale?: Locale;
  wipLimit?: number | null;
  guildIds?: string[];
  teamIds?: string[];
}

/** Как человек YourTask сопоставлен с каталогом YourSpace (docs/adr/0009). */
export const CATALOG_MATCHES = ["subject", "email", "manual", "created", "retired", "unresolved"] as const;
export type CatalogMatch = (typeof CATALOG_MATCHES)[number];

export interface CatalogReportRow {
  person: PersonRef;
  match: CatalogMatch;
  /** Аккаунт YourSpace, с которым связан человек. */
  catalogId: string | null;
  /** Для неразобранных строк — кандидаты из каталога (совпадение имени или почты). */
  candidates: { catalogId: string; name: string; email: string | null }[];
}

export interface CatalogReport {
  lastSyncAt: string | null;
  lastError: string | null;
  counts: Record<CatalogMatch, number>;
  rows: CatalogReportRow[];
}

export type CatalogResolution = { action: "link"; catalogId: string } | { action: "retire" };

/** Колодец: профессиональное объединение, у которого есть лид. */
export interface Guild {
  id: string;
  name: string;
  /** Системное имя латиницей для TQL: «stream = GD» (R-5.3). */
  key: string | null;
  lead: PersonRef | null;
  members: PersonRef[];
}

/** Фичекоманда: продуктовая команда, у которой есть ПМ. */
export interface FeatureTeam {
  id: string;
  name: string;
  /** Системное имя латиницей для TQL: «team = Frogs» (R-5.3). */
  key: string | null;
  pm: PersonRef | null;
  members: PersonRef[];
}

export interface GuildInput {
  name: string;
  key?: string | null;
  leadId?: string | null;
  memberIds?: string[];
}

export interface FeatureTeamInput {
  name: string;
  key?: string | null;
  pmId?: string | null;
  memberIds?: string[];
}

export const DIMENSION_KINDS = ["people_group", "list"] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];
export const DIMENSION_SOURCES = ["feature_teams", "guilds"] as const;
export type DimensionSource = (typeof DIMENSION_SOURCES)[number];

export interface DimensionOption {
  id: string;
  label: string;
}

/** Измерение (R-2.15): «группа людей» (значения — фичекоманды или колодцы) или «список». */
export interface Dimension {
  id: string;
  key: string;
  name: string;
  kind: DimensionKind;
  source: DimensionSource | null;
  multiple: boolean;
  system: boolean;
  options: DimensionOption[];
}

export interface DimensionInput {
  name: string;
  key?: string;
  kind: DimensionKind;
  source?: DimensionSource | null;
  multiple: boolean;
  options?: string[];
}

export * from "./ticket-types.js";
export * from "./estimates.js";
export * from "./workflow.js";
export * from "./tickets.js";
export * from "./history.js";
export * from "./access.js";
export * from "./hierarchy.js";
export * from "./links.js";
export * from "./attachments.js";
export * from "./trash.js";
export * from "./tql.js";
export * from "./products.js";
export * from "./boards.js";
export * from "./notifications.js";
export * from "./wip.js";
