import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import {
  checkUpload,
  FILE_KIND_KEYS,
  FILE_KINDS,
  kindFromName,
  type Attachment,
  type AttachmentSettings,
  type FileKind,
  type UploadSession,
  type UploadStart,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type UserRow } from "../auth/sessions.js";
import { forbidden } from "../access/service.js";
import { idParams } from "../directory/common.js";
import { ticketService, type TicketRow } from "../tickets/service.js";
import { sniff } from "./sniff.js";

/**
 * Вложения (R-2.24, R-3.2; YT-13, docs/adr/0019).
 * - Лимиты и типы проверяются до начала загрузки: и в интерфейсе, и на сервере при открытии загрузки — без 413.
 * - Загрузка частями по 4 МБ; после обрыва клиент спрашивает, сколько байт уже на сервере, и продолжает.
 * - Тип — по содержимому: расширение должно совпасть с сигнатурой. SVG и HTML не принимаются.
 * - Файлы лежат вне публичного каталога под случайными именами; выдаются только через проверку прав на тикет,
 *   с nosniff и CSP sandbox — браузер их не исполнит.
 */
export const CHUNK_SIZE = 4 * 1024 * 1024;
const STALE_UPLOAD_MS = 24 * 3_600_000;

interface SettingsRow {
  max_file_bytes: number;
  max_ticket_bytes: number;
  max_space_bytes: number;
  allowed: string;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  ticket_id: string;
  name: string;
  kind: FileKind;
  mime: string;
  size: number;
  storage_key: string;
  uploaded_by: string | null;
  uploader_name: string | null;
  created_at: number;
}

interface UploadRow {
  id: string;
  ticket_id: string;
  user_id: string;
  name: string;
  kind: FileKind;
  size: number;
  received: number;
}

/** Безопасное имя для показа и скачивания: без путей, управляющих символов и с длиной в разумных пределах. */
export function safeName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F"<>|?*:]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(-200);
  return clean || "file";
}

export function attachmentService(db: Database, root: string, keyPrefix: string) {
  const tickets = ticketService(db, keyPrefix);
  const filesDir = join(root, "files");
  const partsDir = join(root, "uploads");
  const fileOf = (key: string) => join(filesDir, key.slice(0, 2), key);
  const partOf = (id: string) => join(partsDir, `${id}.part`);

  function settings(): AttachmentSettings {
    const row = db.prepare("SELECT * FROM attachment_settings WHERE id = 1").get() as SettingsRow;
    return {
      maxFileBytes: row.max_file_bytes,
      maxTicketBytes: row.max_ticket_bytes,
      maxSpaceBytes: row.max_space_bytes,
      allowed: (JSON.parse(row.allowed) as FileKind[]).filter((kind) => kind in FILE_KINDS),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /** Сколько уже занято: файлы тикета и пространства плюс незавершённые загрузки (их место зарезервировано). */
  function used(ticket: Pick<TicketRow, "id" | "space_id">, exceptUpload?: string) {
    const sum = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number | null }).n ?? 0;
    const pending = (where: string, ...params: unknown[]) =>
      sum(
        `SELECT sum(u.size) AS n FROM attachment_uploads u JOIN tickets t ON t.id = u.ticket_id WHERE ${where} AND u.id <> ?`,
        ...params,
        exceptUpload ?? "",
      );
    return {
      ticket:
        sum("SELECT sum(size) AS n FROM attachments WHERE ticket_id = ?", ticket.id) +
        pending("u.ticket_id = ?", ticket.id),
      space:
        sum(
          "SELECT sum(a.size) AS n FROM attachments a JOIN tickets t ON t.id = a.ticket_id WHERE t.space_id = ?",
          ticket.space_id,
        ) + pending("t.space_id = ?", ticket.space_id),
    };
  }

  function refuse(ticket: TicketRow, file: { name: string; size: number }, exceptUpload?: string) {
    const refusal = checkUpload(settings(), file, used(ticket, exceptUpload));
    if (refusal) {
      throw new AppError(422, "upload_refused", "The file cannot be attached: see `refusal`", undefined, { refusal });
    }
  }

  function toAttachment(viewer: UserRow, row: AttachmentRow, canEdit: boolean): Attachment {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      group: FILE_KINDS[row.kind].group,
      mime: row.mime,
      size: row.size,
      url: `/api/v1/attachments/${row.id}`,
      uploadedBy: row.uploaded_by ? { id: row.uploaded_by, name: row.uploader_name ?? "" } : null,
      createdAt: new Date(row.created_at).toISOString(),
      canDelete: canEdit || row.uploaded_by === viewer.id,
    };
  }

  const selectAttachment = `SELECT a.*, u.name AS uploader_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by`;

  function ownUpload(viewer: UserRow, id: string) {
    const row = db.prepare("SELECT * FROM attachment_uploads WHERE id = ?").get(id) as UploadRow | undefined;
    if (!row || row.user_id !== viewer.id) throw new AppError(404, "not_found", "Upload not found");
    return row;
  }

  async function dropUpload(id: string) {
    db.prepare("DELETE FROM attachment_uploads WHERE id = ?").run(id);
    await rm(partOf(id), { force: true });
  }

  async function cleanStale() {
    const stale = db
      .prepare("SELECT id FROM attachment_uploads WHERE updated_at < ?")
      .all(Date.now() - STALE_UPLOAD_MS) as {
      id: string;
    }[];
    for (const row of stale) await dropUpload(row.id);
  }

  const session = (row: UploadRow, attachment: Attachment | null = null): UploadSession => ({
    id: row.id,
    offset: row.received,
    size: row.size,
    chunkSize: CHUNK_SIZE,
    attachment,
  });

  async function hashOf(path: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  async function finish(viewer: UserRow, upload: UploadRow): Promise<UploadSession> {
    const ticket = tickets.byId(upload.ticket_id);
    // Пока файл грузился, лимиты могли поменять или место могли занять — проверяем ещё раз.
    try {
      refuse(ticket, upload, upload.id);
    } catch (error) {
      await dropUpload(upload.id);
      throw error;
    }
    const id = randomUUID();
    const storageKey = randomUUID();
    const target = fileOf(storageKey);
    await mkdir(join(filesDir, storageKey.slice(0, 2)), { recursive: true });
    await rename(partOf(upload.id), target);
    const sha256 = await hashOf(target);
    const now = Date.now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO attachments (id, ticket_id, name, kind, mime, size, sha256, storage_key, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        ticket.id,
        upload.name,
        upload.kind,
        FILE_KINDS[upload.kind].mime,
        upload.size,
        sha256,
        storageKey,
        viewer.id,
        now,
      );
      db.prepare("DELETE FROM attachment_uploads WHERE id = ?").run(upload.id);
      tickets.history.record(ticket.id, tickets.actorOf(viewer), [
        { field: "attachments", from: null, to: { raw: id, text: upload.name } },
      ]);
    })();
    const row = db.prepare(`${selectAttachment} WHERE a.id = ?`).get(id) as AttachmentRow;
    return session({ ...upload, received: upload.size }, toAttachment(viewer, row, true));
  }

  return {
    settings,

    updateSettings(viewer: UserRow, input: Omit<AttachmentSettings, "updatedAt">) {
      const allowed = [...new Set(input.allowed)].filter((kind) => FILE_KIND_KEYS.includes(kind));
      if (input.maxFileBytes > input.maxTicketBytes || input.maxTicketBytes > input.maxSpaceBytes) {
        throw new AppError(400, "validation_failed", "Limits must grow: file ≤ ticket ≤ space", [
          { field: "maxFileBytes", message: "file ≤ ticket ≤ space" },
        ]);
      }
      db.prepare(
        "UPDATE attachment_settings SET max_file_bytes = ?, max_ticket_bytes = ?, max_space_bytes = ?, allowed = ?, updated_by = ?, updated_at = ? WHERE id = 1",
      ).run(
        input.maxFileBytes,
        input.maxTicketBytes,
        input.maxSpaceBytes,
        JSON.stringify(allowed),
        viewer.id,
        Date.now(),
      );
      tickets.access.log(viewer, "attachments.settings", { ...input, allowed });
      return settings();
    },

    list(viewer: UserRow, key: string): Attachment[] {
      const { row, acc } = tickets.load(viewer, key);
      return (
        db.prepare(`${selectAttachment} WHERE a.ticket_id = ? ORDER BY a.created_at`).all(row.id) as AttachmentRow[]
      ).map((item) => toAttachment(viewer, item, acc.rights.has("edit")));
    },

    /** Открыть загрузку: проверка прав, типа и лимитов до первого байта. */
    async start(viewer: UserRow, key: string, input: UploadStart): Promise<UploadSession> {
      const { row: ticket, acc } = tickets.load(viewer, key);
      tickets.requireRight(acc, "comment");
      await cleanStale();
      const name = safeName(input.name);
      refuse(ticket, { name, size: input.size });
      const kind = kindFromName(name) as FileKind;
      const id = randomUUID();
      await mkdir(partsDir, { recursive: true });
      await (await open(partOf(id), "w")).close();
      const now = Date.now();
      db.prepare(
        "INSERT INTO attachment_uploads (id, ticket_id, user_id, name, kind, size, received, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      ).run(id, ticket.id, viewer.id, name, kind, input.size, now, now);
      return session(ownUpload(viewer, id));
    },

    /** Сколько уже на сервере — с этого места продолжают после обрыва. */
    status(viewer: UserRow, id: string): UploadSession {
      return session(ownUpload(viewer, id));
    },

    /** Часть файла с позиции offset. Позиция не та — 409 с актуальной: клиент продолжит с неё. */
    async chunk(viewer: UserRow, id: string, offset: number, data: Buffer): Promise<UploadSession> {
      const upload = ownUpload(viewer, id);
      tickets.load(viewer, upload.ticket_id);
      if (offset !== upload.received) {
        throw new AppError(409, "conflict", "Continue from the offset the server already has", undefined, {
          offset: upload.received,
        });
      }
      if (data.length === 0 || offset + data.length > upload.size) {
        throw new AppError(400, "validation_failed", "The chunk does not fit the declared size", [
          { field: "offset", message: `the file is ${upload.size} bytes` },
        ]);
      }
      // Тип проверяется по первым байтам сразу — подменённое расширение отклоняется до загрузки остального.
      if (offset === 0 && !sniff(data.subarray(0, 4096)).includes(upload.kind)) {
        await dropUpload(id);
        throw new AppError(
          422,
          "file_type_mismatch",
          `The content of the file is not ${upload.kind.toUpperCase()}: the extension does not match what is inside`,
        );
      }
      await appendFile(partOf(id), data);
      const received = (await stat(partOf(id))).size;
      db.prepare("UPDATE attachment_uploads SET received = ?, updated_at = ? WHERE id = ?").run(
        received,
        Date.now(),
        id,
      );
      const current = { ...upload, received };
      return received >= upload.size ? finish(viewer, current) : session(current);
    },

    async cancel(viewer: UserRow, id: string) {
      ownUpload(viewer, id);
      await dropUpload(id);
    },

    /** Файл для выдачи: только с доступом к содержимому тикета. */
    file(viewer: UserRow, id: string) {
      const row = db.prepare(`${selectAttachment} WHERE a.id = ?`).get(id) as AttachmentRow | undefined;
      if (!row) throw new AppError(404, "not_found", "File not found");
      tickets.load(viewer, row.ticket_id);
      return { row, path: fileOf(row.storage_key) };
    },

    async remove(viewer: UserRow, id: string) {
      const row = db.prepare(`${selectAttachment} WHERE a.id = ?`).get(id) as AttachmentRow | undefined;
      if (!row) throw new AppError(404, "not_found", "File not found");
      const { acc } = tickets.load(viewer, row.ticket_id);
      if (row.uploaded_by !== viewer.id && !acc.rights.has("edit")) throw forbidden("edit");
      db.transaction(() => {
        db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
        tickets.history.record(row.ticket_id, tickets.actorOf(viewer), [
          { field: "attachments", from: { raw: id, text: row.name }, to: null },
        ]);
      })();
      await rm(fileOf(row.storage_key), { force: true });
    },
  };
}

const settingsSchema = {
  type: "object",
  required: ["maxFileBytes", "maxTicketBytes", "maxSpaceBytes", "allowed", "updatedAt"],
  properties: {
    maxFileBytes: { type: "integer" },
    maxTicketBytes: { type: "integer" },
    maxSpaceBytes: { type: "integer" },
    allowed: { type: "array", items: { type: "string" } },
    updatedAt: { type: "string" },
  },
} as const;
const loose = { type: "object", additionalProperties: true } as const;

export const attachmentRoutes: FastifyPluginAsync<{ db: Database; root: string; keyPrefix: string }> = async (
  app,
  { db, root, keyPrefix },
) => {
  const service = attachmentService(db, root, keyPrefix);
  const tags = ["attachments"];
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: CHUNK_SIZE + 1024 },
    (_request, body, done) => done(null, body),
  );

  app.get(
    "/api/v1/attachment-settings",
    {
      schema: {
        tags,
        summary: "Attachment limits and allowed types (the client checks them before uploading)",
        response: { 200: settingsSchema, ...problemResponses },
      },
    },
    async (request) => {
      requireAuth(request);
      return service.settings();
    },
  );

  app.put(
    "/api/v1/attachment-settings",
    {
      schema: {
        tags,
        summary: "Change limits and allowed types (superadmin); applies at once, no restart",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["maxFileBytes", "maxTicketBytes", "maxSpaceBytes", "allowed"],
          properties: {
            maxFileBytes: { type: "integer", minimum: 1024, maximum: 10 * 1024 ** 3 },
            maxTicketBytes: { type: "integer", minimum: 1024, maximum: 100 * 1024 ** 3 },
            maxSpaceBytes: { type: "integer", minimum: 1024, maximum: 100 * 1024 ** 4 },
            allowed: { type: "array", maxItems: 50, items: { type: "string", enum: FILE_KIND_KEYS } },
          },
        },
        response: { 200: settingsSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { realUser } = requireSuperadmin(request);
      return service.updateSettings(realUser, request.body as Omit<AttachmentSettings, "updatedAt">);
    },
  );

  app.get(
    "/api/v1/tickets/:key/attachments",
    {
      schema: {
        tags,
        summary: "Attachments of a ticket",
        params: { type: "object", required: ["key"], properties: { key: { type: "string", maxLength: 64 } } },
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: loose } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: service.list(requireAuth(request).user, (request.params as { key: string }).key) }),
  );

  app.post(
    "/api/v1/tickets/:key/uploads",
    {
      schema: {
        tags,
        summary: "Open an upload: rights, type and limits are checked before the first byte (422 upload_refused)",
        params: { type: "object", required: ["key"], properties: { key: { type: "string", maxLength: 64 } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "size"],
          properties: { name: { type: "string", minLength: 1, maxLength: 300 }, size: { type: "integer", minimum: 1 } },
        },
        response: { 201: loose, ...problemResponses },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.start(
            requireAuth(request).user,
            (request.params as { key: string }).key,
            request.body as UploadStart,
          ),
        ),
  );

  app.get(
    "/api/v1/uploads/:id",
    {
      schema: {
        tags,
        summary: "Where to continue an interrupted upload",
        params: idParams,
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) => service.status(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.put(
    "/api/v1/uploads/:id",
    {
      bodyLimit: CHUNK_SIZE + 1024,
      schema: {
        tags,
        summary:
          "Send a chunk (application/octet-stream, up to 4 MB) at ?offset=. A wrong offset gives 409 with the server's offset",
        params: idParams,
        querystring: { type: "object", required: ["offset"], properties: { offset: { type: "integer", minimum: 0 } } },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      service.chunk(
        requireAuth(request).user,
        (request.params as { id: string }).id,
        (request.query as { offset: number }).offset,
        request.body as Buffer,
      ),
  );

  app.delete(
    "/api/v1/uploads/:id",
    {
      schema: {
        tags,
        summary: "Cancel an upload",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      await service.cancel(requireAuth(request).user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/attachments/:id",
    {
      schema: {
        tags,
        summary: "Download or show a file — only with access to the ticket. Supports Range for video",
        params: idParams,
        querystring: { type: "object", properties: { download: { type: "string" } } },
      },
    },
    async (request, reply) => {
      const { row, path } = service.file(requireAuth(request).user, (request.params as { id: string }).id);
      const group = FILE_KINDS[row.kind].group;
      const inline =
        (group === "image" || group === "video" || row.kind === "pdf") &&
        !(request.query as { download?: string }).download;
      const ascii = row.name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      reply
        .header("Content-Type", row.mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'")
        .header("Cache-Control", "private, max-age=0, must-revalidate")
        .header("Accept-Ranges", "bytes")
        .header(
          "Content-Disposition",
          `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        );
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, row.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), row.size - 1) : row.size - 1;
        if (start >= row.size || start > end) {
          return reply.code(416).header("Content-Range", `bytes */${row.size}`).send();
        }
        return reply
          .code(206)
          .header("Content-Range", `bytes ${start}-${end}/${row.size}`)
          .header("Content-Length", end - start + 1)
          .send(createReadStream(path, { start, end }));
      }
      return reply.header("Content-Length", row.size).send(createReadStream(path));
    },
  );

  app.delete(
    "/api/v1/attachments/:id",
    {
      schema: {
        tags,
        summary: "Delete an attachment (its author or whoever edits the ticket)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      await service.remove(requireAuth(request).user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );
};
