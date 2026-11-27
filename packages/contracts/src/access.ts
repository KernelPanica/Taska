/**
 * Права и видимость (R-2.20, R-5.2; YT-08, docs/adr/0014).
 * Выдача = кто × где × профиль. Профиль — набор прав, у каждого права — области, где оно действует.
 * Здесь только чистые правила; сервер применяет их к каждому запросу.
 */

/** Отдельные права матрицы R-5.2. Системные имена — английские. */
export const RIGHTS = [
  "view",
  "comment",
  "create",
  "edit",
  "status",
  "assign",
  "dates",
  "move",
  "trash",
  "visibility",
  "bulk",
  "assistant",
  "boards_space",
  "boards_personal",
  "configure",
  "automation",
  "wip_override",
  "grant",
  "org",
  "purge",
  "restore",
  "export",
  "directory",
  "tags",
  "frozen",
] as const;
export type Right = (typeof RIGHTS)[number];

/**
 * Где действует право внутри места выдачи:
 * - all — все тикеты места;
 * - team — тикеты своей фичекоманды;
 * - stream — тикеты своего стрима (колодца) в любой команде;
 * - no_team — тикеты своего стрима без фичекоманды (атомарные задачи и реквесты колодца);
 * - own — свои объекты (доски, строка справочника);
 * - own_queued — свои тикеты, пока они в очереди;
 * - own_deleted — удалённое самим человеком (корзина, YT-14).
 */
export const RIGHT_SCOPES = ["all", "team", "stream", "no_team", "own", "own_queued", "own_deleted"] as const;
export type RightScope = (typeof RIGHT_SCOPES)[number];

export type ProfileRights = Partial<Record<Right, RightScope[]>>;

export interface AccessProfile {
  id: string;
  key: string;
  name: string;
  rights: ProfileRights;
  /** Готовый профиль R-5.2: правится и копируется, но не удаляется. */
  system: boolean;
  /** Сколько выдач использует профиль. */
  grants: number;
}

export interface AccessProfileInput {
  name: string;
  key?: string;
  rights: ProfileRights;
}

/** Кто получает права. «Лид колодца» и «ПМ команды» берутся из карточки группы (R-2.15). */
export const SUBJECT_KINDS = ["person", "team", "guild", "team_pm", "guild_lead", "everyone"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface GrantSubject {
  kind: SubjectKind;
  /** Человек, команда или колодец. У team_pm и guild_lead пусто — «ПМ любой команды», «лид любого колодца». */
  id: string | null;
}

/** Где действуют права. Пустые части не ограничивают: всё пусто — во всех пространствах. */
export interface GrantPlace {
  spaceId: string | null;
  /** Ветка: тикет и все его потомки. */
  branchKey: string | null;
  /** Значение измерения: системное имя поля и значение (id команды, колодца или варианта). */
  fieldKey: string | null;
  fieldValue: string | null;
}

export interface AccessGrant {
  id: string;
  /** name — имя человека, команды или колодца; null у «все» и «любой команды / колодца». */
  subject: GrantSubject & { name: string | null };
  place: GrantPlace & { spaceName: string | null; branchTitle: string | null; fieldValueName: string | null };
  profileId: string;
  profileName: string;
  createdAt: string;
}

export interface SecurityEvent {
  id: string;
  at: string;
  actorName: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface AccessGrantInput {
  subject: GrantSubject;
  place: GrantPlace;
  profileId: string;
}

/** Видимость тикета (R-2.20). Пусто — наследуется от родителей. */
export const VISIBILITIES = ["open", "title_only", "hidden"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface VisibilityAllowEntry {
  kind: "person" | "team" | "guild";
  id: string;
  name: string;
}

export interface TicketVisibility {
  /** Задано у самого тикета; null — наследуется. */
  own: Visibility | null;
  /** Действующая для посторонних: своя или унаследованная. */
  effective: Visibility;
  /** Откуда унаследована (ключ предка), если не своя. */
  inheritedFrom: string | null;
  allow: VisibilityAllowEntry[];
}

export interface VisibilityInput {
  version: number;
  visibility: Visibility | null;
  allow?: { kind: "person" | "team" | "guild"; id: string }[];
}

/** Что зритель может делать с тикетом — для кнопок интерфейса. Решает всегда сервер. */
export type TicketPermissions = Record<
  "comment" | "edit" | "status" | "assign" | "dates" | "move" | "trash" | "visibility" | "create" | "export",
  boolean
>;

/** «Смотреть как» и «Режим показа»: чьими глазами отвечает API в этой сессии. */
export interface Lens {
  kind: "profile" | "person";
  id: string;
  name: string;
  /** Включён «Режим показа» из шапки (профиль), а не разовый «Смотреть как». */
  show: boolean;
}

// ---- Готовые профили R-5.2 ----

export const STARTER_PROFILE_KEYS = [
  "superadmin",
  "space_admin",
  "team_pm",
  "guild_lead",
  "member",
  "observer",
] as const;
export type StarterProfileKey = (typeof STARTER_PROFILE_KEYS)[number];

const ALL: RightScope[] = ["all"];

/** Матрица R-5.2 построчно: право → значение для шести профилей (null — нет права). */
export const R52_MATRIX: Record<Right, Record<StarterProfileKey, RightScope[] | null>> = {
  view: { superadmin: ALL, space_admin: ALL, team_pm: ALL, guild_lead: ALL, member: ALL, observer: ALL },
  comment: { superadmin: ALL, space_admin: ALL, team_pm: ALL, guild_lead: ALL, member: ALL, observer: ALL },
  create: { superadmin: ALL, space_admin: ALL, team_pm: ALL, guild_lead: ALL, member: ALL, observer: null },
  edit: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["stream"],
    member: ["team"],
    observer: null,
  },
  status: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["no_team"],
    member: ["team"],
    observer: null,
  },
  assign: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["no_team"],
    member: ["team"],
    observer: null,
  },
  dates: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["no_team"],
    member: ["team"],
    observer: null,
  },
  move: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["stream"],
    member: ["team"],
    observer: null,
  },
  trash: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["stream"],
    member: ["own_queued"],
    observer: null,
  },
  visibility: { superadmin: ALL, space_admin: ALL, team_pm: null, guild_lead: null, member: null, observer: null },
  bulk: { superadmin: ALL, space_admin: ALL, team_pm: ["team"], guild_lead: ["stream"], member: null, observer: null },
  assistant: { superadmin: ALL, space_admin: ALL, team_pm: ALL, guild_lead: ALL, member: null, observer: null },
  boards_space: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["own"],
    member: null,
    observer: null,
  },
  boards_personal: { superadmin: ALL, space_admin: ALL, team_pm: ALL, guild_lead: ALL, member: ALL, observer: ALL },
  configure: { superadmin: ALL, space_admin: ALL, team_pm: null, guild_lead: null, member: null, observer: null },
  automation: { superadmin: ALL, space_admin: ALL, team_pm: null, guild_lead: null, member: null, observer: null },
  wip_override: { superadmin: ALL, space_admin: ALL, team_pm: null, guild_lead: null, member: null, observer: null },
  // Админ пространства выдаёт права «в своём пространстве»: его выдача и так ограничена местом.
  grant: { superadmin: ALL, space_admin: ALL, team_pm: null, guild_lead: null, member: null, observer: null },
  org: { superadmin: ALL, space_admin: null, team_pm: null, guild_lead: null, member: null, observer: null },
  purge: { superadmin: ALL, space_admin: null, team_pm: null, guild_lead: null, member: null, observer: null },
  restore: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["own_deleted"],
    member: ["own_deleted"],
    observer: null,
  },
  export: { superadmin: ALL, space_admin: ALL, team_pm: null, guild_lead: null, member: null, observer: null },
  directory: {
    superadmin: ALL,
    space_admin: null,
    team_pm: ["team"],
    guild_lead: ["stream"],
    member: ["own"],
    observer: null,
  },
  tags: { superadmin: ALL, space_admin: ALL, team_pm: null, guild_lead: null, member: null, observer: null },
  frozen: {
    superadmin: ALL,
    space_admin: ALL,
    team_pm: ["team"],
    guild_lead: ["stream"],
    member: null,
    observer: null,
  },
};

/** Права готового профиля из матрицы R-5.2. */
export function starterRights(key: StarterProfileKey): ProfileRights {
  const rights: ProfileRights = {};
  for (const right of RIGHTS) {
    const scopes = R52_MATRIX[right][key];
    if (scopes) rights[right] = [...scopes];
  }
  return rights;
}

// ---- Проверка области ----

/** Тикет глазами правил: команда, стримы, автор, категория статуса. */
export interface ScopeTicket {
  team: string | null;
  streams: readonly string[];
  createdBy: string | null;
  category: "queue" | "in_progress" | "done";
  deletedBy?: string | null;
}

/** Контекст выдачи: чьи команды и колодцы считаются «своими» для этой выдачи. */
export interface ScopeContext {
  userId: string;
  teams: ReadonlySet<string>;
  guilds: ReadonlySet<string>;
}

export function scopeMatches(scope: RightScope, context: ScopeContext, ticket: ScopeTicket): boolean {
  switch (scope) {
    case "all":
      return true;
    case "team":
      return ticket.team !== null && context.teams.has(ticket.team);
    case "stream":
      return ticket.streams.some((stream) => context.guilds.has(stream));
    case "no_team":
      return ticket.team === null && ticket.streams.some((stream) => context.guilds.has(stream));
    case "own":
      return ticket.createdBy === context.userId;
    case "own_queued":
      return ticket.createdBy === context.userId && ticket.category === "queue";
    case "own_deleted":
      return Boolean(ticket.deletedBy) && ticket.deletedBy === context.userId;
  }
}

export function rightAllows(
  rights: ProfileRights,
  right: Right,
  context: ScopeContext,
  ticket: ScopeTicket | null,
): boolean {
  const scopes = rights[right];
  if (!scopes?.length) return false;
  // Без тикета (право в пространстве: создать, выдать) достаточно любой области.
  if (!ticket) return true;
  return scopes.some((scope) => scopeMatches(scope, context, ticket));
}

// ---- Видимость ----

/** Ограничение, действующее на тикет: от самого тикета или от предка с явной видимостью. */
export interface Restriction {
  sourceId: string;
  visibility: Exclude<Visibility, "open">;
  /** Зритель допущен к содержимому источника (список допущенных, право «менять видимость», суперадмин). */
  exempt: boolean;
}

export type AccessLevel = "full" | "title" | "none";

/**
 * Уровень доступа к тикету по его ограничениям (R-2.20):
 * «только заголовок» у самого тикета — посторонний видит название и прогресс;
 * у предка — потомки скрыты целиком («содержимое и дети — только перечисленным»); «скрыт» — не виден.
 */
export function accessLevel(ticketId: string, restrictions: readonly Restriction[]): AccessLevel {
  let level: AccessLevel = "full";
  for (const item of restrictions) {
    if (item.exempt) continue;
    if (item.visibility === "title_only" && item.sourceId === ticketId) level = "title";
    else return "none";
  }
  return level;
}

/**
 * Какие ограничения у тикета: явная своя видимость важнее унаследованной (явное «открыт» снимает
 * ограничения предков), иначе — все ограничения родителей.
 */
export function ownRestrictions(ticketId: string, own: Visibility | null, fromParents: readonly string[]): string[] {
  if (own === "open") return [];
  if (own) return [ticketId];
  return [...new Set(fromParents)];
}
