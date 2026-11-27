import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type {
  LinkType,
  LinkTypeInput,
  LinkWarning,
  Ticket,
  TicketLink,
  TicketLinkInput,
  TicketLinkPatch,
  WebLink,
  WebLinkInput,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type Auth, type SessionStore, type UserRow } from "../auth/sessions.js";
import { forbidden, type ViewerContext } from "../access/service.js";
import { idParams, isUniqueViolation, nameSchema } from "../directory/common.js";
import { systemKey } from "../ticket-types/common.js";
import { fetchTitle } from "../integrations/link-preview.js";
import { documentIdFrom, SignInAgainError, type WikiCredential, type YourWiki } from "../integrations/yourwiki.js";
import { ticketService, type TicketRow, type TicketService } from "./service.js";

/**
 * Связи между тикетами и блок ссылок (R-2.13, R-2.17, R-2.24, R-2.40; YT-12, docs/adr/0018).
 * Связь хранится один раз и видна с обеих сторон; смена типа — одно действие; удаление связи тикеты не трогает.
 */
interface LinkRow {
  id: string;
  type_id: string;
  from_id: string;
  to_id: string;
}

interface TypeRow {
  id: string;
  key: string;
  name: string;
  inverse_name: string;
  symmetric: number;
  is_system: number;
  links: number;
}

const toType = (row: TypeRow): LinkType => ({
  id: row.id,
  key: row.key,
  name: row.name,
  inverseName: row.inverse_name,
  symmetric: row.symmetric === 1,
  system: row.is_system === 1,
  links: row.links,
});

export function linkService(db: Database, tickets: TicketService) {
  const { history, access } = tickets;

  function types(viewer: UserRow, where = "1 = 1", ...params: unknown[]): LinkType[] {
    return (
      db
        .prepare(
          `SELECT t.*, (SELECT count(*) FROM ticket_links l WHERE l.type_id = t.id) AS links FROM link_types t
           WHERE ${viewer.isTest ? "1 = 1" : "t.is_test = 0"} AND ${where} ORDER BY t.is_system DESC, t.created_at, t.rowid`,
        )
        .all(...params) as TypeRow[]
    ).map(toType);
  }

  function type(viewer: UserRow, id: string) {
    const found = types(viewer, "t.id = ?", id)[0];
    if (!found)
      throw new AppError(400, "validation_failed", "Unknown link type", [{ field: "typeId", message: "not found" }]);
    return found;
  }

  const label = (linkType: LinkType, direction: "out" | "in") =>
    direction === "out" || linkType.symmetric ? linkType.name : linkType.inverseName;

  const forTicket = (viewer: UserRow, ticketId: string, ctx: ViewerContext): TicketLink[] =>
    tickets.linksFor(viewer, ticketId, ctx);

  const text = (linkType: LinkType, direction: "out" | "in", other: Pick<TicketRow, "id" | "key" | "title">) => ({
    raw: other.id,
    text: `${label(linkType, direction)}: ${other.key} ${other.title}`,
  });

  /** Запись о связи в журнал обеих сторон. */
  function record(
    viewer: UserRow,
    linkType: LinkType,
    from: TicketRow,
    to: TicketRow,
    change: "add" | "remove",
    previous?: LinkType,
  ) {
    const now = Date.now();
    const actor = tickets.actorOf(viewer);
    const sides: [TicketRow, TicketRow, "out" | "in"][] = [
      [from, to, "out"],
      [to, from, "in"],
    ];
    for (const [self, other, direction] of sides) {
      const value = text(linkType, direction, other);
      history.record(
        self.id,
        actor,
        [
          change === "add"
            ? { field: "links", from: previous ? text(previous, direction, other) : null, to: value }
            : { field: "links", from: value, to: null },
        ],
        now,
      );
    }
  }

  /** Связь, которую зритель может менять: правка хотя бы одной стороны и обе стороны видны целиком. */
  function editable(viewer: UserRow, id: string, ctx: ViewerContext) {
    const row = db.prepare("SELECT * FROM ticket_links WHERE id = ?").get(id) as LinkRow | undefined;
    if (!row) throw new AppError(404, "not_found", "Link not found");
    const from = tickets.load(viewer, row.from_id, ctx);
    const to = tickets.load(viewer, row.to_id, ctx);
    if (!from.acc.rights.has("edit") && !to.acc.rights.has("edit")) throw forbidden("edit");
    return { row, from: from.row, to: to.row };
  }

  return {
    types,
    forTicket,

    createType(viewer: UserRow, input: LinkTypeInput) {
      const id = randomUUID();
      const key = systemKey(input.name, input.key, "link");
      const symmetric = Boolean(input.symmetric);
      try {
        db.prepare(
          `INSERT INTO link_types (id, key, name, inverse_name, symmetric, is_system, is_test, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        ).run(
          id,
          key,
          input.name.trim(),
          symmetric ? input.name.trim() : input.inverseName?.trim() || input.name.trim(),
          Number(symmetric),
          viewer.isTest ? 1 : 0,
          Date.now(),
          Date.now(),
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError(409, "conflict", `Link type key "${key}" is already used`);
        throw error;
      }
      return type(viewer, id);
    },

    updateType(viewer: UserRow, id: string, input: Partial<LinkTypeInput>) {
      const current = type(viewer, id);
      db.prepare("UPDATE link_types SET name = ?, inverse_name = ?, updated_at = ? WHERE id = ?").run(
        input.name?.trim() ?? current.name,
        current.symmetric ? (input.name?.trim() ?? current.name) : (input.inverseName?.trim() ?? current.inverseName),
        Date.now(),
        id,
      );
      return type(viewer, id);
    },

    deleteType(viewer: UserRow, id: string) {
      const current = type(viewer, id);
      if (current.system) throw new AppError(409, "conflict", "Link types of R-2.13 cannot be deleted");
      if (current.links) throw new AppError(409, "conflict", `The type is used by ${current.links} link(s)`);
      db.prepare("DELETE FROM link_types WHERE id = ?").run(id);
    },

    /** Добавить связь со стороны тикета key; direction in — цель «откуда», этот тикет «куда». */
    add(viewer: UserRow, key: string, input: TicketLinkInput): Ticket {
      const ctx = access.context(viewer);
      const self = tickets.load(viewer, key, ctx);
      const target = tickets.load(viewer, input.targetKey, ctx);
      tickets.requireRight(self.acc, "edit");
      if (target.row.id === self.row.id) {
        throw new AppError(400, "validation_failed", "A ticket cannot be linked to itself", [
          { field: "targetKey", message: "the same ticket" },
        ]);
      }
      const linkType = type(viewer, input.typeId);
      const [from, to] = input.direction === "in" ? [target.row, self.row] : [self.row, target.row];
      const exists = db
        .prepare(
          `SELECT 1 FROM ticket_links WHERE type_id = ? AND ((from_id = ? AND to_id = ?) ${linkType.symmetric ? "OR (from_id = ? AND to_id = ?)" : ""})`,
        )
        .get(linkType.id, from.id, to.id, ...(linkType.symmetric ? [to.id, from.id] : []));
      if (exists) throw new AppError(409, "link_exists", "These tickets are already linked this way");
      db.transaction(() => {
        db.prepare(
          "INSERT INTO ticket_links (id, type_id, from_id, to_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(randomUUID(), linkType.id, from.id, to.id, viewer.id, Date.now());
        record(viewer, linkType, from, to, "add");
        // Баг по связи «вызывает» не входит в прогресс (R-2.12): свёртка стороны «откуда» пересчитывается.
        tickets.rollups.recompute([from.id]);
      })();
      return tickets.get(viewer, self.row.id);
    },

    /** Смена типа одним действием (R-2.13); direction — со стороны fromKey. */
    change(viewer: UserRow, id: string, input: TicketLinkPatch): Ticket {
      const ctx = access.context(viewer);
      const { row, from, to } = editable(viewer, id, ctx);
      const previous = type(viewer, row.type_id);
      const next = type(viewer, input.typeId);
      const self = tickets.load(viewer, input.fromKey, ctx).row;
      if (self.id !== from.id && self.id !== to.id)
        throw new AppError(400, "validation_failed", "fromKey is not a side of the link");
      const other = self.id === from.id ? to : from;
      const direction = input.direction ?? (self.id === from.id ? "out" : "in");
      const [newFrom, newTo] = direction === "out" ? [self, other] : [other, self];
      db.transaction(() => {
        try {
          db.prepare("UPDATE ticket_links SET type_id = ?, from_id = ?, to_id = ? WHERE id = ?").run(
            next.id,
            newFrom.id,
            newTo.id,
            id,
          );
        } catch (error) {
          if (isUniqueViolation(error))
            throw new AppError(409, "link_exists", "These tickets are already linked this way");
          throw error;
        }
        record(viewer, next, newFrom, newTo, "add", previous);
        tickets.rollups.recompute([from.id, to.id]);
      })();
      return tickets.get(viewer, self.id);
    },

    /** Удаление связи тикеты не трогает. */
    remove(viewer: UserRow, id: string, fromKey: string): Ticket {
      const ctx = access.context(viewer);
      const { row, from, to } = editable(viewer, id, ctx);
      const linkType = type(viewer, row.type_id);
      db.transaction(() => {
        db.prepare("DELETE FROM ticket_links WHERE id = ?").run(id);
        record(viewer, linkType, from, to, "remove");
        tickets.rollups.recompute([from.id]);
      })();
      return tickets.get(viewer, fromKey);
    },
  };
}

export type LinkService = ReturnType<typeof linkService>;

// ---- блок ссылок ----

interface WebRow {
  id: string;
  ticket_id: string;
  kind: "web" | "yourwiki";
  url: string;
  document_id: string | null;
  title: string | null;
  created_at: number;
}

export function webLinkService(db: Database, tickets: TicketService, wiki: YourWiki | null, allowPrivate: boolean) {
  const requested = db.prepare("SELECT 1 FROM yourwiki_access_requests WHERE user_id = ? AND url = ?");

  /** Документ глазами зрителя — WK-02 от его имени. Ошибки не роняют карточку: ссылка помечается. */
  async function documentFor(row: WebRow, who: WikiCredential) {
    if (!wiki) return { error: "wiki_down" as const };
    try {
      return { doc: row.document_id ? await wiki.document(row.document_id, who) : await wiki.resolve(row.url, who) };
    } catch (error) {
      return { error: error instanceof SignInAgainError ? ("sign_in_again" as const) : ("wiki_down" as const) };
    }
  }

  async function list(viewer: UserRow, who: WikiCredential, key: string): Promise<WebLink[]> {
    const ticket = tickets.get(viewer, key);
    const rows = db
      .prepare("SELECT * FROM ticket_web_links WHERE ticket_id = ? ORDER BY position")
      .all(ticket.id) as WebRow[];
    const hidden = ticket.visibility.effective !== "open";
    return Promise.all(
      rows.map(async (row): Promise<WebLink> => {
        const base = { id: row.id, kind: row.kind, url: row.url, createdAt: new Date(row.created_at).toISOString() };
        if (row.kind === "web") return { ...base, title: row.title, document: null, warning: null };
        const result = await documentFor(row, who);
        if ("error" in result)
          return { ...base, title: null, document: null, warning: null, unavailable: result.error };
        const doc = result.doc;
        // Расхождение доступов (R-2.24): считаем, только если YourWiki сообщает, кому открыт документ.
        const warning: LinkWarning | null =
          doc.state !== "available" || !doc.audience
            ? null
            : hidden && doc.audience === "everyone"
              ? "ticket_hidden_document_open"
              : !hidden && doc.audience === "restricted"
                ? "ticket_open_document_restricted"
                : null;
        return {
          ...base,
          // Название — только живое и только если YourWiki его показал этому человеку.
          title: doc.title,
          document: {
            state: doc.state,
            access: doc.access,
            source: doc.source,
            wikiUrl: doc.access !== "none" && doc.url ? doc.url : null,
            originalUrl: doc.original.available && doc.original.url ? doc.original.url : null,
            canRequestAccess: doc.canRequestAccess,
            requested: Boolean(requested.get(viewer.id, row.url)),
          },
          warning,
        };
      }),
    );
  }

  return {
    list,

    async add(viewer: UserRow, who: WikiCredential, key: string, input: WebLinkInput) {
      const { row: ticket, acc } = tickets.load(viewer, key);
      tickets.requireRight(acc, "edit");
      let url: URL;
      try {
        url = new URL(input.url.trim());
      } catch {
        throw new AppError(400, "validation_failed", "Paste a full address starting with http:// or https://", [
          { field: "url", message: "not a URL" },
        ]);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new AppError(400, "validation_failed", "Only http and https links", [
          { field: "url", message: "unsupported scheme" },
        ]);
      }
      const isWiki = Boolean(wiki?.owns(url.href));
      const documentId = isWiki && wiki ? documentIdFrom(wiki.baseUrl, url.href) : null;
      // У документа YourWiki название не храним: его показывают живым и только тем, кому YourWiki его открыл.
      const title = isWiki ? null : input.title?.trim() || (await fetchTitle(url.href, allowPrivate));
      const position =
        ((
          db.prepare("SELECT max(position) AS p FROM ticket_web_links WHERE ticket_id = ?").get(ticket.id) as {
            p: number | null;
          }
        ).p ?? 0) + 1;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO ticket_web_links (id, ticket_id, kind, url, document_id, title, title_fetched_at, position, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          ticket.id,
          isWiki ? "yourwiki" : "web",
          url.href,
          documentId,
          title,
          Date.now(),
          position,
          viewer.id,
          Date.now(),
        );
        tickets.history.record(ticket.id, tickets.actorOf(viewer), [
          { field: "webLinks", from: null, to: { raw: url.href, text: isWiki ? url.href : (title ?? url.href) } },
        ]);
      })();
      return list(viewer, who, ticket.key);
    },

    async remove(viewer: UserRow, who: WikiCredential, id: string) {
      const row = db.prepare("SELECT * FROM ticket_web_links WHERE id = ?").get(id) as WebRow | undefined;
      if (!row) throw new AppError(404, "not_found", "Link not found");
      const { row: ticket, acc } = tickets.load(viewer, row.ticket_id);
      tickets.requireRight(acc, "edit");
      db.transaction(() => {
        db.prepare("DELETE FROM ticket_web_links WHERE id = ?").run(id);
        tickets.history.record(ticket.id, tickets.actorOf(viewer), [
          {
            field: "webLinks",
            from: { raw: row.url, text: row.kind === "web" ? (row.title ?? row.url) : row.url },
            to: null,
          },
        ]);
      })();
      return list(viewer, who, ticket.key);
    },

    /** «Запросить»: запрос уходит в YourWiki от имени человека; права там не трогаем. */
    async requestAccess(viewer: UserRow, realUser: UserRow, who: WikiCredential, id: string) {
      const row = db.prepare("SELECT * FROM ticket_web_links WHERE id = ?").get(id) as WebRow | undefined;
      if (!row || row.kind !== "yourwiki") throw new AppError(404, "not_found", "Document link not found");
      const { row: ticket } = tickets.load(viewer, row.ticket_id);
      if (!wiki) throw new AppError(502, "integration_unavailable", "YourWiki is not connected");
      try {
        await wiki.requestAccess(row.url, `Из YourTask, тикет ${ticket.key}`, who);
      } catch (error) {
        if (error instanceof SignInAgainError) {
          throw new AppError(409, "conflict", "Sign in again to YourTask so that YourWiki knows who you are");
        }
        throw error;
      }
      db.prepare("INSERT OR IGNORE INTO yourwiki_access_requests (user_id, url, created_at) VALUES (?, ?, ?)").run(
        realUser.id,
        row.url,
        Date.now(),
      );
      return list(viewer, who, ticket.key);
    },
  };
}

export type WebLinkService = ReturnType<typeof webLinkService>;

// ---- маршруты ----

const typeSchema = {
  type: "object",
  required: ["id", "key", "name", "inverseName", "symmetric", "system", "links"],
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    inverseName: { type: "string" },
    symmetric: { type: "boolean" },
    system: { type: "boolean" },
    links: { type: "integer" },
  },
} as const;
const loose = { type: "object", additionalProperties: true } as const;
const keyParams = {
  type: "object",
  required: ["key"],
  properties: { key: { type: "string", maxLength: 64 } },
} as const;
const webList = {
  200: { type: "object", required: ["items"], properties: { items: { type: "array", items: loose } } },
  ...problemResponses,
};

export const linkRoutes: FastifyPluginAsync<{
  db: Database;
  keyPrefix: string;
  wiki: YourWiki | null;
  linkPreviewPrivate: boolean;
  sessions: SessionStore;
}> = async (app, { db, keyPrefix, wiki, linkPreviewPrivate, sessions }) => {
  /** Кто спрашивает YourWiki: человек сессии (не линза «смотреть как»), его токен YourSpace и sub. */
  const who = (auth: Auth): WikiCredential => ({
    token: sessions.yourspaceToken(auth.session),
    subject: auth.realUser.yourspaceSubject ?? null,
  });
  const tickets = ticketService(db, keyPrefix);
  const links = linkService(db, tickets);
  const web = webLinkService(db, tickets, wiki, linkPreviewPrivate);
  const tags = ["links"];

  app.get(
    "/api/v1/link-types",
    {
      schema: {
        tags,
        summary: "Link types of R-2.13 and the ones an admin added",
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: typeSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => ({ items: links.types(requireAuth(request).user) }),
  );

  const typeBody = {
    type: "object",
    additionalProperties: false,
    properties: {
      name: nameSchema,
      inverseName: nameSchema,
      symmetric: { type: "boolean" },
      key: { type: "string", maxLength: 60 },
    },
  } as const;

  app.post(
    "/api/v1/link-types",
    {
      schema: {
        tags,
        summary: "Add a link type (superadmin)",
        body: { ...typeBody, required: ["name"] },
        response: { 201: typeSchema, ...problemResponses },
      },
    },
    async (request, reply) =>
      reply.code(201).send(links.createType(requireSuperadmin(request).user, request.body as LinkTypeInput)),
  );

  app.patch(
    "/api/v1/link-types/:id",
    {
      schema: {
        tags,
        summary: "Rename a link type (superadmin)",
        params: idParams,
        body: { ...typeBody, minProperties: 1 },
        response: { 200: typeSchema, ...problemResponses },
      },
    },
    async (request) =>
      links.updateType(
        requireSuperadmin(request).user,
        (request.params as { id: string }).id,
        request.body as Partial<LinkTypeInput>,
      ),
  );

  app.delete(
    "/api/v1/link-types/:id",
    {
      schema: {
        tags,
        summary: "Delete an unused custom link type (superadmin)",
        params: idParams,
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      links.deleteType(requireSuperadmin(request).user, (request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/tickets/:key/links",
    {
      schema: {
        tags,
        summary:
          "Link two tickets (any spaces). direction in: the target is the «from» side. A duplicate gives link_exists",
        params: keyParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["typeId", "targetKey"],
          properties: {
            typeId: { type: "string", maxLength: 64 },
            targetKey: { type: "string", maxLength: 40 },
            direction: { type: "string", enum: ["out", "in"] },
          },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      links.add(requireAuth(request).user, (request.params as { key: string }).key, request.body as TicketLinkInput),
  );

  app.patch(
    "/api/v1/links/:id",
    {
      schema: {
        tags,
        summary: "Change the link type in one action (e.g. blocks → relates to); the tickets stay",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["typeId", "fromKey"],
          properties: {
            typeId: { type: "string", maxLength: 64 },
            fromKey: { type: "string", maxLength: 40 },
            direction: { type: "string", enum: ["out", "in"] },
          },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      links.change(requireAuth(request).user, (request.params as { id: string }).id, request.body as TicketLinkPatch),
  );

  app.delete(
    "/api/v1/links/:id",
    {
      schema: {
        tags,
        summary: "Remove a link; the tickets stay",
        params: idParams,
        querystring: {
          type: "object",
          required: ["fromKey"],
          properties: { fromKey: { type: "string", maxLength: 40 } },
        },
        response: { 200: loose, ...problemResponses },
      },
    },
    async (request) =>
      links.remove(
        requireAuth(request).user,
        (request.params as { id: string }).id,
        (request.query as { fromKey: string }).fromKey,
      ),
  );

  app.get(
    "/api/v1/tickets/:key/web-links",
    {
      schema: {
        tags,
        summary:
          "Links block: web pages with titles and YourWiki documents with a live title, access and state for the viewer",
        params: keyParams,
        response: webList,
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return { items: await web.list(auth.user, who(auth), (request.params as { key: string }).key) };
    },
  );

  app.post(
    "/api/v1/tickets/:key/web-links",
    {
      schema: {
        tags,
        summary: "Add a link: any http(s) address (the page title is fetched) or a YourWiki document address",
        params: keyParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string", minLength: 1, maxLength: 2000 },
            title: { type: "string", maxLength: 300 },
          },
        },
        response: webList,
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return {
        items: await web.add(
          auth.user,
          who(auth),
          (request.params as { key: string }).key,
          request.body as WebLinkInput,
        ),
      };
    },
  );

  app.delete(
    "/api/v1/web-links/:id",
    { schema: { tags, summary: "Remove a link from the block", params: idParams, response: webList } },
    async (request) => {
      const auth = requireAuth(request);
      return { items: await web.remove(auth.user, who(auth), (request.params as { id: string }).id) };
    },
  );

  app.post(
    "/api/v1/web-links/:id/request-access",
    {
      schema: {
        tags,
        summary: "Ask YourWiki for access to the document (YourWiki rights are not synchronised)",
        params: idParams,
        response: webList,
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return {
        items: await web.requestAccess(auth.user, auth.realUser, who(auth), (request.params as { id: string }).id),
      };
    },
  );
};
