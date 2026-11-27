import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { CommentMentions, HistoryValue, TicketComment } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, type UserRow } from "../auth/sessions.js";
import { createdAsTest, personRefSchema, toPersonRef, type PersonRefRow } from "../directory/common.js";
import { placeholders } from "../ticket-types/common.js";
import { historyService } from "./history.js";
import { ticketService } from "./service.js";
import { excerptOf, notifier } from "../notifications/service.js";

/**
 * Комментарии к тикету (R-2.25; YT-07, docs/adr/0013): Markdown, упоминания `@логин` и ключей тикетов,
 * правка своих, удаление своих (суперадмин — любых), «Сделать тикетом».
 * Удаление мягкое: в ленте остаётся «комментарий удалён», текст больше не отдаётся.
 */
interface CommentRow {
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_name: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  created_ticket_id: string | null;
}

const MENTION_PERSON = /(^|[^\w@.])@([A-Za-z0-9][A-Za-z0-9._-]{1,63})/g;

export function commentService(db: Database, keyPrefix: string) {
  const tickets = ticketService(db, keyPrefix);
  const history = historyService(db);
  const ticketKey = new RegExp(`\\b${keyPrefix}-\\d+\\b`, "g");

  /** Кого и что упомянули: логины людей из каталога и ключи тикетов. */
  function extract(body: string) {
    // Одно и то же упоминание может встретиться несколько раз: в запрос — только уникальные.
    const logins = [
      ...new Set(
        [...body.matchAll(MENTION_PERSON)].map((match) => (match[2] ?? "").replace(/[._-]+$/, "").toLowerCase()),
      ),
    ];
    const keys = [...new Set([...body.matchAll(ticketKey)].map((match) => match[0]))];
    const people = logins.length
      ? (db
          .prepare(
            `SELECT p.username AS login, u.id, u.name FROM catalog_profiles p JOIN users u ON u.id = p.user_id
             WHERE lower(p.username) IN (${placeholders(logins)})`,
          )
          .all(...logins) as { login: string; id: string; name: string }[])
      : [];
    const found = keys.length
      ? (db.prepare(`SELECT id, key FROM tickets WHERE key IN (${placeholders(keys)})`).all(...keys) as {
          id: string;
          key: string;
        }[])
      : [];
    return { people, tickets: found };
  }

  function writeMentions(commentId: string, body: string) {
    const { people, tickets: found } = extract(body);
    db.prepare("DELETE FROM comment_mentions WHERE comment_id = ?").run(commentId);
    const insert = db.prepare("INSERT OR IGNORE INTO comment_mentions (comment_id, kind, target_id) VALUES (?, ?, ?)");
    for (const person of people) insert.run(commentId, "person", person.id);
    for (const ticket of found) insert.run(commentId, "ticket", ticket.id);
  }

  /** Упоминания глазами зрителя: недоступные тикеты не раскрываются (R-2.17). */
  function mentions(viewer: UserRow, body: string): CommentMentions {
    const { people, tickets: found } = extract(body);
    const visible = found.flatMap((item) => {
      try {
        const ticket = tickets.get(viewer, item.id);
        const status = db.prepare("SELECT name FROM scheme_statuses WHERE id = ?").get(ticket.statusId) as
          | { name: string }
          | undefined;
        return [{ key: ticket.key, title: ticket.title, statusName: status?.name ?? null }];
      } catch {
        return [];
      }
    });
    return { people, tickets: visible };
  }

  function hydrate(viewer: UserRow, row: CommentRow): TicketComment {
    const author = row.author_id
      ? (db
          .prepare("SELECT id, name, email, deactivated_at IS NOT NULL AS deactivated FROM users WHERE id = ?")
          .get(row.author_id) as PersonRefRow | undefined)
      : undefined;
    let createdTicket: TicketComment["createdTicket"] = null;
    if (row.created_ticket_id) {
      try {
        const ticket = tickets.get(viewer, row.created_ticket_id);
        const status = db.prepare("SELECT name, category FROM scheme_statuses WHERE id = ?").get(ticket.statusId) as
          | { name: string; category: string }
          | undefined;
        createdTicket = {
          key: ticket.key,
          title: ticket.title,
          statusName: status?.name ?? null,
          category: status?.category ?? null,
        };
      } catch {
        createdTicket = null;
      }
    }
    const deleted = row.deleted_at !== null;
    const own = row.author_id === viewer.id;
    return {
      id: row.id,
      ticketId: row.ticket_id,
      author: author ? toPersonRef(author) : null,
      authorName: author?.name ?? row.author_name,
      body: deleted ? "" : row.body,
      createdAt: new Date(row.created_at).toISOString(),
      editedAt: row.edited_at === null ? null : new Date(row.edited_at).toISOString(),
      deleted,
      mentions: deleted ? { people: [], tickets: [] } : mentions(viewer, row.body),
      createdTicket,
      canEdit: !deleted && own,
      canDelete: !deleted && (own || viewer.role === "superadmin"),
    };
  }

  /** Комментарий, к тикету которого у зрителя есть доступ. */
  function find(viewer: UserRow, id: string) {
    const row = db.prepare("SELECT * FROM ticket_comments WHERE id = ?").get(id) as CommentRow | undefined;
    if (!row) throw new AppError(404, "not_found", "Comment not found");
    tickets.get(viewer, row.ticket_id);
    return row;
  }

  const body = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed)
      throw new AppError(400, "validation_failed", "Write something", [{ field: "body", message: "empty comment" }]);
    return trimmed;
  };

  const service = {
    /** Упоминания в тексте глазами зрителя: описание тикета разбирается так же, как комментарий (R-2.24). */
    mentions,
    list(viewer: UserRow, key: string) {
      const ticket = tickets.get(viewer, key);
      return (
        db
          .prepare("SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at, rowid")
          .all(ticket.id) as CommentRow[]
      ).map((row) => hydrate(viewer, row));
    },
    create(viewer: UserRow, key: string, text: string) {
      const loaded = tickets.load(viewer, key);
      tickets.requireRight(loaded.acc, "comment");
      const ticket = loaded.row;
      const id = randomUUID();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, created_at, is_test)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, ticket.id, viewer.id, viewer.name, body(text), Date.now(), createdAsTest(viewer));
        writeMentions(id, text);
      })();
      // Упомянутым — «упоминание» со ссылкой; наблюдателям — «новый комментарий» (кроме уже упомянутых).
      const mentioned = extract(text).people.map((person) => person.id);
      const watchers = (
        db.prepare("SELECT user_id FROM ticket_people WHERE ticket_id = ? AND role = 'watcher'").all(ticket.id) as {
          user_id: string;
        }[]
      ).map((row) => row.user_id);
      const entry = { ticketId: ticket.id, excerpt: excerptOf(text), commentId: id };
      notifier(db).publish({ kind: "mentioned", actorId: viewer.id, recipients: mentioned, entries: [entry] });
      notifier(db).publish({
        kind: "commented",
        actorId: viewer.id,
        recipients: watchers.filter((user) => !mentioned.includes(user)),
        entries: [entry],
      });
      return hydrate(viewer, find(viewer, id));
    },
    update(viewer: UserRow, id: string, text: string) {
      const row = find(viewer, id);
      if (row.deleted_at !== null) throw new AppError(409, "conflict", "The comment is deleted");
      if (row.author_id !== viewer.id) throw new AppError(403, "forbidden", "You can edit only your own comments");
      tickets.requireRight(tickets.load(viewer, row.ticket_id).acc, "comment");
      db.transaction(() => {
        db.prepare("UPDATE ticket_comments SET body = ?, edited_at = ? WHERE id = ?").run(body(text), Date.now(), id);
        writeMentions(id, text);
      })();
      return hydrate(viewer, find(viewer, id));
    },
    remove(viewer: UserRow, id: string) {
      const row = find(viewer, id);
      if (row.deleted_at !== null) return hydrate(viewer, row);
      if (row.author_id !== viewer.id && viewer.role !== "superadmin") {
        throw new AppError(403, "forbidden", "You can delete only your own comments");
      }
      db.prepare("UPDATE ticket_comments SET deleted_at = ?, deleted_by = ? WHERE id = ?").run(
        Date.now(),
        viewer.id,
        id,
      );
      db.prepare("DELETE FROM comment_mentions WHERE comment_id = ?").run(id);
      return hydrate(viewer, find(viewer, id));
    },

    /** «Сделать тикетом»: задача в том же пространстве со ссылкой на комментарий и исполнителем. */
    makeTicket(viewer: UserRow, id: string, input: { title: string; assigneeId?: string | null; typeId?: string }) {
      const row = find(viewer, id);
      if (row.deleted_at !== null) throw new AppError(409, "conflict", "The comment is deleted");
      if (row.created_ticket_id) throw new AppError(409, "conflict", "A ticket was already made from this comment");
      const source = tickets.get(viewer, row.ticket_id);
      const typeId =
        input.typeId ??
        (db.prepare("SELECT id FROM ticket_types WHERE key = 'task'").get() as { id: string } | undefined)?.id ??
        source.typeId;
      const quote = row.body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      let createdKey = "";
      db.transaction(() => {
        const created = tickets.create(
          viewer,
          { spaceId: source.spaceId, typeId, title: input.title },
          `from comment on ${source.key}`,
        );
        createdKey = created.key;
        const description = `Из комментария ${row.author_name} к [${source.key}](/tickets/${source.key}#comment-${row.id}):\n\n${quote}\n`;
        tickets.update(viewer, created.key, {
          version: created.version,
          description,
          ...(input.assigneeId ? { people: { assigneeIds: [input.assigneeId] } } : {}),
        });
        db.prepare("UPDATE ticket_comments SET created_ticket_id = ? WHERE id = ?").run(created.id, row.id);
        history.record(source.id, { id: viewer.id, name: viewer.name, source: "person" }, [
          { field: "comment.ticket", from: null, to: { raw: created.key, text: `${created.key} ${created.title}` } },
        ]);
      })();
      return { comment: hydrate(viewer, find(viewer, id)), ticketKey: createdKey };
    },
  };
  return service;
}

const commentSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    ticketId: { type: "string" },
    author: { anyOf: [personRefSchema, { type: "null" }] },
    authorName: { type: "string" },
    body: { type: "string", description: "Markdown; empty when deleted" },
    createdAt: { type: "string" },
    editedAt: { type: ["string", "null"] },
    deleted: { type: "boolean" },
    mentions: {
      type: "object",
      properties: {
        people: {
          type: "array",
          items: {
            type: "object",
            properties: { login: { type: "string" }, id: { type: "string" }, name: { type: "string" } },
          },
        },
        tickets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              title: { type: "string" },
              statusName: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    createdTicket: {
      anyOf: [
        {
          type: "object",
          properties: {
            key: { type: "string" },
            title: { type: "string" },
            statusName: { type: ["string", "null"] },
            category: { type: ["string", "null"] },
          },
        },
        { type: "null" },
      ],
    },
    canEdit: { type: "boolean" },
    canDelete: { type: "boolean" },
  },
} as const;

const historySchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    at: { type: "string" },
    actor: { anyOf: [personRefSchema, { type: "null" }] },
    actorName: { type: ["string", "null"] },
    source: { type: "string", enum: ["person", "system", "rule", "assistant"] },
    sourceDetail: { type: ["string", "null"] },
    field: { type: "string" },
    fieldLabel: { type: ["string", "null"] },
    from: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
    to: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
  },
} as const;

const keyParams = {
  type: "object",
  required: ["key"],
  properties: { key: { type: "string", maxLength: 64 } },
} as const;
const idParams = { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } } as const;
/** Записи журнала, ссылающиеся на другой тикет: raw — его id. */
const LINK_FIELDS = new Set(["parents", "children", "links"]);

const bodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: { body: { type: "string", maxLength: 50_000 } },
} as const;

export const historyRoutes: FastifyPluginAsync<{ db: Database; keyPrefix: string }> = async (
  app,
  { db, keyPrefix },
) => {
  const tickets = ticketService(db, keyPrefix);
  const history = historyService(db);
  const comments = commentService(db, keyPrefix);
  const tags = ["history"];

  app.get(
    "/api/v1/tickets/:key/history",
    {
      schema: {
        tags,
        summary: "Append-only change log of a ticket: who, when, what, from, to, source",
        description: "There is no way to change or delete an entry: neither in the API nor in the database.",
        params: keyParams,
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: historySchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const viewer = requireAuth(request).user;
      const { row, acc } = tickets.load(viewer, (request.params as { key: string }).key);
      // Маска полей и недоступные связанные тикеты действуют и в журнале (R-2.20, R-2.17).
      const masked = tickets.access.maskedFields(acc.profiles);
      const items = history
        .list(row.id)
        .filter((entry) => !(entry.field.startsWith("values.") && masked.has(entry.field.slice(7))));
      const linked = items
        .filter((entry) => LINK_FIELDS.has(entry.field))
        .flatMap((entry) => [entry.from?.raw, entry.to?.raw])
        .filter((raw): raw is string => typeof raw === "string");
      const accs = tickets.access.evaluateMany(viewer, linked);
      const hide = (value: HistoryValue | null) =>
        value && typeof value.raw === "string" && (accs.get(value.raw)?.level ?? "none") === "none"
          ? { raw: null, text: "" }
          : value;
      return {
        items: items.map((entry) =>
          LINK_FIELDS.has(entry.field) ? { ...entry, from: hide(entry.from), to: hide(entry.to) } : entry,
        ),
      };
    },
  );

  app.get(
    "/api/v1/tickets/:key/status-history",
    {
      schema: {
        tags,
        summary: "Status sequence with dates, for flow metrics (JSON or CSV)",
        params: keyParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { format: { type: "string", enum: ["json", "csv"], default: "json" } },
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { row: ticket, acc } = tickets.load(auth.user, (request.params as { key: string }).key);
      const periods = history.statusPeriods(ticket.id);
      if ((request.query as { format: string }).format !== "csv") return { key: ticket.key, items: periods };
      // Выгрузка — отдельное право; каждый экспорт пишется в журнал безопасности (R-2.20, R-3.2).
      tickets.requireRight(acc, "export");
      tickets.access.log(auth.realUser, "export.status_history", { key: ticket.key, format: "csv" });
      const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [
        ["key", "status", "category", "outcome", "entered_at", "left_at", "by"].join(","),
        ...periods.map((period) =>
          [ticket.key, period.name, period.category, period.outcome, period.enteredAt, period.leftAt, period.actorName]
            .map(cell)
            .join(","),
        ),
      ].join("\n");
      return reply
        .type("text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${ticket.key}-statuses.csv"`)
        .send(`${csv}\n`);
    },
  );

  app.get(
    "/api/v1/tickets/:key/mentions",
    {
      schema: {
        tags,
        summary: "Mentions in the ticket description, resolved for the viewer: people by @login and tickets by key",
        params: keyParams,
        response: {
          200: {
            type: "object",
            additionalProperties: true,
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const viewer = requireAuth(request).user;
      const ticket = tickets.get(viewer, (request.params as { key: string }).key);
      return comments.mentions(viewer, ticket.description);
    },
  );

  const one = { 200: commentSchema, ...problemResponses };

  app.get(
    "/api/v1/tickets/:key/comments",
    {
      schema: {
        tags: ["comments"],
        summary: "Comments of a ticket, oldest first",
        params: keyParams,
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: commentSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: comments.list(requireAuth(request).user, (request.params as { key: string }).key) }),
  );

  app.post(
    "/api/v1/tickets/:key/comments",
    {
      schema: {
        tags: ["comments"],
        summary: "Comment in Markdown; mention people with @login and tickets by key",
        params: keyParams,
        body: bodySchema,
        response: { 201: commentSchema, ...problemResponses },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          comments.create(
            requireAuth(request).user,
            (request.params as { key: string }).key,
            (request.body as { body: string }).body,
          ),
        ),
  );

  app.patch(
    "/api/v1/comments/:id",
    { schema: { tags: ["comments"], summary: "Edit my comment", params: idParams, body: bodySchema, response: one } },
    async (request) =>
      comments.update(
        requireAuth(request).user,
        (request.params as { id: string }).id,
        (request.body as { body: string }).body,
      ),
  );

  app.delete(
    "/api/v1/comments/:id",
    {
      schema: {
        tags: ["comments"],
        summary: "Delete a comment: mine, or any as superadmin. A placeholder stays in the thread.",
        params: idParams,
        response: one,
      },
    },
    async (request) => comments.remove(requireAuth(request).user, (request.params as { id: string }).id),
  );

  app.post(
    "/api/v1/comments/:id/make-ticket",
    {
      schema: {
        tags: ["comments"],
        summary: "Make a task from a comment: it links back to the comment, the comment shows its status",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
            assigneeId: { type: ["string", "null"], maxLength: 64 },
            typeId: { type: "string", maxLength: 64 },
          },
        },
        response: {
          201: { type: "object", properties: { comment: commentSchema, ticketKey: { type: "string" } } },
          ...problemResponses,
        },
      },
    },
    async (request, reply) => {
      const { user } = requireAuth(request);
      const result = comments.makeTicket(
        user,
        (request.params as { id: string }).id,
        request.body as { title: string; assigneeId?: string | null; typeId?: string },
      );
      return reply.code(201).send(result);
    },
  );
};
