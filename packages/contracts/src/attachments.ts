/**
 * Вложения (R-2.24, R-3.2; YT-13, docs/adr/0019). Тип файла — по содержимому, не по расширению.
 */

export type FileGroup = "image" | "video" | "document";

/** Типы, которые админ может разрешить. SVG и HTML не поддерживаются: в них может быть скрипт (R-3.2). */
export const FILE_KINDS = {
  png: { mime: "image/png", group: "image", extensions: ["png"] },
  jpg: { mime: "image/jpeg", group: "image", extensions: ["jpg", "jpeg"] },
  gif: { mime: "image/gif", group: "image", extensions: ["gif"] },
  webp: { mime: "image/webp", group: "image", extensions: ["webp"] },
  mp4: { mime: "video/mp4", group: "video", extensions: ["mp4", "m4v"] },
  mov: { mime: "video/quicktime", group: "video", extensions: ["mov"] },
  webm: { mime: "video/webm", group: "video", extensions: ["webm"] },
  pdf: { mime: "application/pdf", group: "document", extensions: ["pdf"] },
  txt: { mime: "text/plain; charset=utf-8", group: "document", extensions: ["txt", "log"] },
  md: { mime: "text/markdown; charset=utf-8", group: "document", extensions: ["md"] },
  csv: { mime: "text/csv; charset=utf-8", group: "document", extensions: ["csv"] },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    group: "document",
    extensions: ["docx"],
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    group: "document",
    extensions: ["xlsx"],
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    group: "document",
    extensions: ["pptx"],
  },
  zip: { mime: "application/zip", group: "document", extensions: ["zip"] },
} as const satisfies Record<string, { mime: string; group: FileGroup; extensions: readonly string[] }>;

export type FileKind = keyof typeof FILE_KINDS;
export const FILE_KIND_KEYS = Object.keys(FILE_KINDS) as FileKind[];

/** Тип по расширению имени файла; null — неизвестное расширение. */
export function kindFromName(name: string): FileKind | null {
  const extension = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  if (!extension) return null;
  return FILE_KIND_KEYS.find((kind) => (FILE_KINDS[kind].extensions as readonly string[]).includes(extension)) ?? null;
}

export interface AttachmentSettings {
  maxFileBytes: number;
  maxTicketBytes: number;
  maxSpaceBytes: number;
  allowed: FileKind[];
  updatedAt: string;
}

export interface Attachment {
  id: string;
  name: string;
  kind: FileKind;
  group: FileGroup;
  mime: string;
  size: number;
  /** Адрес выдачи через проверку прав; его же вставляют в описание и комментарии. */
  url: string;
  uploadedBy: { id: string; name: string } | null;
  createdAt: string;
  /** Зритель может удалить: автор вложения или тот, кто правит тикет. */
  canDelete: boolean;
}

export interface UploadStart {
  name: string;
  size: number;
}

export interface UploadSession {
  id: string;
  /** Сколько байт уже на сервере: отсюда продолжать после обрыва. */
  offset: number;
  size: number;
  chunkSize: number;
  /** Загрузка завершена: вложение создано. */
  attachment: Attachment | null;
}

/** Почему файл нельзя загрузить — проверка до начала загрузки (и в интерфейсе, и на сервере). */
export type UploadRefusal =
  | { reason: "type"; kind: string }
  | { reason: "file_size"; limit: number }
  | { reason: "ticket_size"; limit: number; used: number }
  | { reason: "space_size"; limit: number; used: number };

export function checkUpload(
  settings: Pick<AttachmentSettings, "maxFileBytes" | "maxTicketBytes" | "maxSpaceBytes" | "allowed">,
  file: { name: string; size: number },
  used: { ticket: number; space: number },
): UploadRefusal | null {
  const kind = kindFromName(file.name);
  if (!kind || !settings.allowed.includes(kind)) return { reason: "type", kind: file.name.split(".").pop() ?? "" };
  if (file.size > settings.maxFileBytes) return { reason: "file_size", limit: settings.maxFileBytes };
  if (used.ticket + file.size > settings.maxTicketBytes)
    return { reason: "ticket_size", limit: settings.maxTicketBytes, used: used.ticket };
  if (used.space + file.size > settings.maxSpaceBytes)
    return { reason: "space_size", limit: settings.maxSpaceBytes, used: used.space };
  return null;
}
