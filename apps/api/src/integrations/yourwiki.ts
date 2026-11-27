import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { WikiDocument } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError } from "../errors.js";

/**
 * YourWiki через его API WK-02 (R-2.40, R-2.24; YT-12, docs/adr/0018). Прямого доступа к хранилищу нет,
 * права не синхронизируются — только читаются для конкретного человека.
 *
 * Контракт WK-02 (код — yourwiki, apps/server/src/integrations), Bearer — токен доступа YourSpace человека:
 * - GET  {base}/api/integrations/documents/{id}           → WikiDocument;
 * - GET  {base}/api/integrations/documents/resolve?url=…  → WikiDocument (адрес YourWiki или исходника);
 * - POST {base}/api/integrations/documents/access-requests { url, message? } → { id, status }.
 * Недоступный документ приходит как `unavailable` без названия: YourTask его и не раскрывает.
 */
export interface WikiCredential {
  /** Токен доступа YourSpace из сессии; без него настоящий YourWiki человека не узнает. */
  token: string | null;
  subject: string | null;
}

export interface YourWiki {
  readonly baseUrl: string;
  /** Адрес ведёт в YourWiki (а не на внешний сайт). */
  owns(url: string): boolean;
  document(id: string, who: WikiCredential): Promise<WikiDocument>;
  resolve(url: string, who: WikiCredential): Promise<WikiDocument>;
  requestAccess(url: string, message: string, who: WikiCredential): Promise<void>;
}

export class SignInAgainError extends Error {
  override name = "SignInAgainError";
}

export const documentIdFrom = (baseUrl: string, url: string) => {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return null;
    const prefix = `${base.pathname.replace(/\/+$/, "")}/documents/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const id = decodeURIComponent(parsed.pathname.slice(prefix.length)).replace(/\/+$/, "");
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
};

/** Клиент настоящего YourWiki (WK-02): каждый вызов — от имени человека его токеном YourSpace. */
export class YourWikiApi implements YourWiki {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 3000,
  ) {}

  owns(url: string) {
    return documentIdFrom(this.baseUrl, url) !== null;
  }

  private async call<T>(path: string, who: WikiCredential, init: RequestInit = {}): Promise<T> {
    if (!who.token) throw new SignInAgainError("No YourSpace token in this session");
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/integrations/documents${path}`, {
      ...init,
      redirect: "error",
      headers: { authorization: `Bearer ${who.token}`, accept: "application/json", "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401) throw new SignInAgainError("YourWiki did not accept the YourSpace token");
    if (!response.ok) throw new AppError(502, "integration_unavailable", `YourWiki answered ${response.status}`);
    return (await response.json()) as T;
  }

  document(id: string, who: WikiCredential) {
    return this.call<WikiDocument>(`/${encodeURIComponent(id)}`, who);
  }

  resolve(url: string, who: WikiCredential) {
    return this.call<WikiDocument>(`/resolve?${new URLSearchParams({ url })}`, who);
  }

  async requestAccess(url: string, message: string, who: WikiCredential) {
    await this.call(`/access-requests`, who, {
      method: "POST",
      body: JSON.stringify({ url, ...(message ? { message } : {}) }),
    });
  }
}

export const DEV_YOURWIKI_PATH = "/dev/yourwiki";

interface DocRow {
  id: string;
  title: string;
  state: "active" | "trashed" | "deleted";
  open_to_all: number;
  original_url: string | null;
}

const hidden = (): WikiDocument => ({
  id: null,
  url: null,
  title: null,
  state: "unavailable",
  access: "none",
  source: null,
  original: { available: false, reason: "not_available" },
  canRequestAccess: true,
});

/**
 * Заглушка YourWiki для разработки и автотестов: ответы как у WK-02, данные — в своих таблицах.
 * Стартовые документы — для сценария карточки: ГДД открыт всем (оригинал в Google — у суперадмина и Анны),
 * ТехГДД — только суперадмину.
 */
export class DevYourWiki implements YourWiki {
  constructor(
    private readonly db: Database,
    readonly baseUrl: string,
  ) {
    const now = Date.now();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO dev_yourwiki_documents (id, title, state, open_to_all, original_url, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
    );
    insert.run(
      "gdd-combat",
      "ГДД: боевая система",
      1,
      "https://docs.google.com/document/d/gdd-combat-original/edit",
      now,
    );
    insert.run("tech-camera", "ТехГДД: камера", 0, null, now);
    insert.run("team-mechanics", "Механика работы фичекоманд", 1, null, now);
    const grant = db.prepare(
      "INSERT OR IGNORE INTO dev_yourwiki_access (document_id, subject, original) VALUES (?, ?, ?)",
    );
    grant.run("gdd-combat", "ys-test-admin", 1);
    grant.run("gdd-combat", "ys-test-anna", 1);
    grant.run("tech-camera", "ys-test-admin", 0);
  }

  owns(url: string) {
    return documentIdFrom(this.baseUrl, url) !== null;
  }

  /** Как LinkedDocuments.metadata в WK-02. */
  metadata(id: string | null, subject: string | null): WikiDocument {
    if (!id) return hidden();
    const row = this.db.prepare("SELECT * FROM dev_yourwiki_documents WHERE id = ?").get(id) as DocRow | undefined;
    if (!row) return hidden();
    const grant = subject
      ? (this.db
          .prepare("SELECT original FROM dev_yourwiki_access WHERE document_id = ? AND subject = ?")
          .get(id, subject) as { original: number } | undefined)
      : undefined;
    if (row.open_to_all !== 1 && !grant) return hidden();
    const state = row.state === "active" ? "available" : row.state;
    const original =
      state === "available" && row.original_url && grant?.original === 1
        ? { available: true, url: row.original_url }
        : { available: false, reason: "source_access_not_verified" };
    return {
      id,
      url: `${this.baseUrl}/documents/${encodeURIComponent(id)}`,
      title: state === "deleted" ? null : row.title,
      state,
      access: state === "available" ? "read" : "none",
      source:
        state === "deleted"
          ? null
          : row.original_url
            ? { type: "google", name: "Google Диск" }
            : { type: "local", name: "YourWiki" },
      original,
      canRequestAccess: false,
      audience: row.open_to_all === 1 ? "everyone" : "restricted",
    };
  }

  async document(id: string, who: WikiCredential) {
    return this.metadata(id, who.subject);
  }

  async resolve(url: string, who: WikiCredential) {
    return this.metadata(documentIdFrom(this.baseUrl, url), who.subject);
  }

  request(url: string, subject: string) {
    const id = documentIdFrom(this.baseUrl, url);
    if (!id || !this.db.prepare("SELECT 1 FROM dev_yourwiki_documents WHERE id = ?").get(id)) return;
    if (
      !this.db.prepare("SELECT 1 FROM dev_yourwiki_requests WHERE document_id = ? AND subject = ?").get(id, subject)
    ) {
      this.db
        .prepare("INSERT INTO dev_yourwiki_requests (id, document_id, subject, created_at) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), id, subject, Date.now());
    }
  }

  async requestAccess(url: string, _message: string, who: WikiCredential) {
    if (who.subject) this.request(url, who.subject);
  }
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escape(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:.4rem;text-align:left;vertical-align:top}
input,select,button{font:inherit}</style></head><body>${body}</body></html>`;

/**
 * Страницы и API заглушки: «админ YourWiki» переименовывает документы, кладёт в корзину и выдаёт доступ;
 * страница документа; API по контракту WK-02 (токен человека проверяет заглушка YourSpace).
 */
export const devYourWikiRoutes: FastifyPluginAsync<{
  db: Database;
  wiki: DevYourWiki;
  userinfo: (token: string) => string | null;
}> = async (app, { db, wiki, userinfo }) => {
  const P = DEV_YOURWIKI_PATH;
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  const html = (reply: FastifyReply, body: string, status = 200) =>
    reply.code(status).header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(body);

  app.get(P, { schema: { hide: true } }, async (_request, reply) => {
    const docs = db.prepare("SELECT * FROM dev_yourwiki_documents ORDER BY title").all() as DocRow[];
    const access = db.prepare(
      "SELECT subject, original FROM dev_yourwiki_access WHERE document_id = ? ORDER BY subject",
    );
    const requests = db.prepare("SELECT subject FROM dev_yourwiki_requests WHERE document_id = ? ORDER BY created_at");
    const rows = docs
      .map((doc) => {
        const subjects = (access.all(doc.id) as { subject: string; original: number }[]).map(
          (row) => `${row.subject}${row.original ? " (+оригинал)" : ""}`,
        );
        const asked = (requests.all(doc.id) as { subject: string }[]).map((row) => row.subject);
        const states = ["active", "trashed", "deleted"]
          .map((state) => `<option ${state === doc.state ? "selected" : ""}>${state}</option>`)
          .join("");
        return `<tr><td><a href="${P}/documents/${escape(doc.id)}">${escape(doc.title)}</a><br><small>${escape(`${wiki.baseUrl}/documents/${doc.id}`)}</small></td>
<td><form method="post" action="${P}/documents/${escape(doc.id)}"><input name="title" value="${escape(doc.title)}" aria-label="Название ${escape(doc.id)}">
<select name="state" aria-label="Состояние ${escape(doc.id)}">${states}</select>
<label><input type="checkbox" name="open" ${doc.open_to_all ? "checked" : ""}> открыт всем</label>
<input name="grant" placeholder="выдать доступ: sub" aria-label="Выдать доступ ${escape(doc.id)}"> <button>Сохранить</button></form></td>
<td>${subjects.map(escape).join(", ") || "—"}</td><td>${asked.map(escape).join(", ") || "—"}</td></tr>`;
      })
      .join("");
    return html(
      reply,
      page(
        "YourWiki (заглушка)",
        `<h1>YourWiki — заглушка для разработки</h1><p>«Админ YourWiki» переименовывает документы, кладёт их в корзину и выдаёт доступ. YourTask читает это через API WK-02 от имени каждого человека.</p>
<table><thead><tr><th>Документ</th><th>Правка</th><th>Доступ (sub)</th><th>Запросили доступ</th></tr></thead><tbody>${rows}</tbody></table>`,
      ),
    );
  });

  app.post(`${P}/documents/:id`, { schema: { hide: true } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: string; state?: string; open?: string; grant?: string };
    if (!db.prepare("SELECT 1 FROM dev_yourwiki_documents WHERE id = ?").get(id)) {
      return html(reply, page("Нет", "<h1>Нет документа</h1>"), 404);
    }
    const state = ["active", "trashed", "deleted"].includes(body.state ?? "") ? body.state : "active";
    db.prepare(
      "UPDATE dev_yourwiki_documents SET title = coalesce(nullif(trim(?), ''), title), state = ?, open_to_all = ?, updated_at = ? WHERE id = ?",
    ).run(body.title ?? "", state, body.open ? 1 : 0, Date.now(), id);
    if (body.grant?.trim()) {
      db.prepare("INSERT OR IGNORE INTO dev_yourwiki_access (document_id, subject, original) VALUES (?, ?, 0)").run(
        id,
        body.grant.trim(),
      );
      db.prepare("DELETE FROM dev_yourwiki_requests WHERE document_id = ? AND subject = ?").run(id, body.grant.trim());
    }
    return reply.redirect(P, 303);
  });

  app.get(`${P}/documents/:id`, { schema: { hide: true } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = db.prepare("SELECT * FROM dev_yourwiki_documents WHERE id = ?").get(id) as DocRow | undefined;
    if (!doc || doc.state === "deleted") return html(reply, page("Документ удалён", "<h1>Документ удалён</h1>"), 404);
    const trash = doc.state === "trashed" ? "<p><strong>В корзине.</strong></p>" : "";
    return html(
      reply,
      page(
        doc.title,
        `<p><a href="${P}">← YourWiki</a></p><h1>${escape(doc.title)}</h1>${trash}<p>Документ в YourWiki (заглушка).</p>`,
      ),
    );
  });

  // Страница с заголовком — для показа превью внешней ссылки.
  app.get("/dev/pages/:name", { schema: { hide: true } }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const titles: Record<string, string> = { reference: "Референс: переключение героя в бою" };
    return html(reply, page(titles[name] ?? name, `<h1>${escape(titles[name] ?? name)}</h1>`));
  });

  // ---- API WK-02 ----
  const API = `${P}/api/integrations/documents`;
  const subjectOf = (request: FastifyRequest) => {
    const header = request.headers.authorization ?? "";
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return null;
    return userinfo(header.slice(7));
  };
  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: { code: "SESSION_REQUIRED" } });

  app.get(`${API}/resolve`, { schema: { hide: true } }, async (request, reply) => {
    const subject = subjectOf(request);
    if (!subject) return unauthorized(reply);
    return wiki.metadata(documentIdFrom(wiki.baseUrl, (request.query as { url?: string }).url ?? ""), subject);
  });

  app.post(`${API}/access-requests`, { schema: { hide: true } }, async (request, reply) => {
    const subject = subjectOf(request);
    if (!subject) return unauthorized(reply);
    const { url } = (request.body ?? {}) as { url?: string };
    if (!url) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    wiki.request(url, subject);
    return reply.code(201).send({ id: randomUUID(), status: "submitted" });
  });

  app.get(`${API}/:id`, { schema: { hide: true } }, async (request, reply) => {
    const subject = subjectOf(request);
    if (!subject) return unauthorized(reply);
    return wiki.metadata((request.params as { id: string }).id, subject);
  });
};
