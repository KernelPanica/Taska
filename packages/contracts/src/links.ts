/**
 * Связи между тикетами и блок ссылок (R-2.13, R-2.24, R-2.40, R-2.17; YT-12, docs/adr/0018).
 */
import type { RelatedTicket } from "./hierarchy.js";

/** Тип связи. Со стороны «откуда» читается name, со стороны «куда» — inverseName. */
export interface LinkType {
  id: string;
  key: string;
  name: string;
  inverseName: string;
  /** Читается одинаково с обеих сторон («связан с»). */
  symmetric: boolean;
  /** Системный тип R-2.13: правится только название, не удаляется. */
  system: boolean;
  /** Сколько связей этого типа. */
  links: number;
}

export interface LinkTypeInput {
  name: string;
  inverseName?: string;
  symmetric?: boolean;
  key?: string;
}

/** Связь глазами зрителя: подпись своей стороны и связанный тикет (недоступный — без ключа и названия). */
export interface TicketLink {
  id: string;
  typeId: string;
  typeKey: string;
  /** «out» — этот тикет «откуда» (блокирует), «in» — «куда» (заблокирован). */
  direction: "out" | "in";
  label: string;
  ticket: RelatedTicket;
}

export interface TicketLinkInput {
  typeId: string;
  targetKey: string;
  /** out: этот тикет → цель (по умолчанию); in: цель → этот тикет. */
  direction?: "out" | "in";
}

export interface TicketLinkPatch {
  typeId: string;
  /** Смена направления вместе с типом — со стороны тикета, где показана связь. */
  direction?: "out" | "in";
  /** Ключ тикета, со стороны которого меняют связь. */
  fromKey: string;
}

/**
 * Документ YourWiki глазами конкретного человека — ответ WK-02
 * (`GET {YourWiki}/api/integrations/documents/{id}` и `/resolve?url=`, Bearer — токен YourSpace человека).
 * Недоступный человеку документ приходит как `unavailable` без id, названия и адреса. Права не синхронизируются.
 */
export interface WikiDocument {
  id: string | null;
  url: string | null;
  title: string | null;
  state: "available" | "trashed" | "deleted" | "unavailable";
  access: "write" | "read" | "none";
  source: { type: string; name: string } | null;
  /** «Открыть оригинал» в исходном сервисе — только при проверенном доступе там. */
  original: { available: boolean; url?: string; reason?: string };
  canRequestAccess: boolean;
  /** Кому открыт документ в YourWiki (предложение к WK-02); без него предупреждение о расхождении не считается. */
  audience?: "everyone" | "restricted";
}

export type LinkWarning = "ticket_hidden_document_open" | "ticket_open_document_restricted";

/** Ссылка в блоке «Ссылки». */
export interface WebLink {
  id: string;
  kind: "web" | "yourwiki";
  /** Адрес, который добавили. */
  url: string;
  /** Заголовок страницы (web). У документа YourWiki — только живое название из WK-02 для этого зрителя. */
  title: string | null;
  document: {
    state: WikiDocument["state"];
    access: WikiDocument["access"];
    source: WikiDocument["source"];
    /** Страница документа в YourWiki — если человеку он доступен. */
    wikiUrl: string | null;
    /** Оригинал в исходном сервисе — только при доступе в источнике. */
    originalUrl: string | null;
    canRequestAccess: boolean;
    /** Человек уже отправил запрос из YourTask. */
    requested: boolean;
  } | null;
  /** YourWiki не ответил или нет токена YourSpace в сессии: состояние неизвестно. */
  unavailable?: "wiki_down" | "sign_in_again";
  warning: LinkWarning | null;
  createdAt: string;
}

export interface WebLinkInput {
  url: string;
  /** Своя подпись вместо заголовка страницы (только для обычных ссылок). */
  title?: string;
}
