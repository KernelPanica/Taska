import type { PersonRef } from "./index.js";

/**
 * WIP-лимиты и перегруз (R-2.21, R-2.27), docs/adr/0025.
 * Лимит — на зону доски, на схему статусов и на человека (личная норма). Режим «предупреждение» или «запрет».
 */
export const WIP_MODES = ["warn", "block"] as const;
export type WipMode = (typeof WIP_MODES)[number];

/** Загрузка человека: «ok» — ниже нормы, «limit» — ровно на норме, «over» — перегруз. Цвет всегда дублируется текстом. */
export type LoadLevel = "ok" | "limit" | "over";

export function loadLevel(load: number, norm: number): LoadLevel {
  return load > norm ? "over" : load === norm ? "limit" : "ok";
}

/** Загрузка человека: тикеты в работе во всех пространствах и командах; статусы «ожидание» не считаются. */
export interface PersonLoad {
  person: PersonRef;
  load: number;
  norm: number;
  level: LoadLevel;
  /** Откуда загрузка: по фичекомандам тикетов (null — тикеты без команды). */
  teams: { id: string | null; name: string | null; count: number }[];
  /** Кто видит этот перегруз (R-2.21): сам человек, ПМы его команд, лиды его колодцев — для подписи баннера. */
  audience: { pms: string[]; leads: string[] };
}

/** Тяжесть перегруза: сначала у кого больше задач сверх нормы, затем по доле. */
export function bySeverity(a: Pick<PersonLoad, "load" | "norm">, b: Pick<PersonLoad, "load" | "norm">) {
  return b.load - b.norm - (a.load - a.norm) || b.load / Math.max(b.norm, 1) - a.load / Math.max(a.norm, 1);
}

const LEVEL_ORDER: Record<LoadLevel, number> = { over: 0, limit: 1, ok: 2 };

/** Порядок панели загрузки: сначала перегруженные (по тяжести), затем на пределе, затем на норме. */
export function byLoad(a: PersonLoad, b: PersonLoad) {
  return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || bySeverity(a, b) || a.person.name.localeCompare(b.person.name);
}

/** Перегруз на доске глазами зрителя (R-2.21): что видно — решает сервер. */
export interface BoardWip {
  /** Панель загрузки участников: только люди, за кого зритель отвечает (или все — админу пространства). */
  panel: PersonLoad[];
  /** Перегруженные для баннера: сам зритель, люди его команд (ПМ) и колодцев (лид). Админу — пусто. */
  banner: PersonLoad[];
  /** Зритель видит баннер о себе («Вы перегружены»). */
  selfOverloaded: boolean;
  /** Команды доски (из фильтра): размер и сколько перегружено — для «Перегружена команда». */
  teams: { id: string; name: string; size: number; overloaded: number }[];
  /** Порог «перегружена команда», доля участников в процентах (по умолчанию треть). */
  teamShare: number;
  /** На доске действует режим запрета (пространство доски или её команда). */
  blocked: boolean;
}

export interface WipSettings {
  /** Норма по умолчанию для тех, у кого личная не задана (R-5.5: 3). */
  defaultNorm: number;
  /** Окно накопления уведомлений о перегрузе, минут (R-2.27: 15). */
  windowMinutes: number;
  /** Порог «перегружена команда», % участников. */
  teamShare: number;
  /** Час утренней сводки по времени сервера. */
  digestHour: number;
}

/** Обход запрета: только с причиной; причина уходит в историю тикета. */
export interface WipOverride {
  reason: string;
}

/** Расширение ошибки 409 wip_blocked: что именно упёрлось в лимит. */
export interface WipBlocked {
  people: { id: string; name: string; load: number; norm: number }[];
  scheme: { name: string; count: number; limit: number } | null;
  zone: { name: string; count: number; limit: number } | null;
  canOverride: boolean;
}

/** Человек в уведомлении о перегрузе. */
export interface OverloadPerson {
  person: PersonRef;
  load: number;
  norm: number;
}
