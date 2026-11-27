import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "./config.js";
import { migrate, openDatabase, orm as createOrm, type Database } from "./db/index.js";
import { problemResponses, registerErrorHandling, sendProblem } from "./errors.js";
import { DevYourSpace, devYourSpaceRoutes } from "./auth/dev-yourspace.js";
import { OidcYourSpace } from "./auth/oidc-provider.js";
import type { IdentityProvider } from "./auth/provider.js";
import { authRoutes } from "./auth/routes.js";
import { accessRoutes } from "./access/routes.js";
import {
  DEV_YOURWIKI_PATH,
  DevYourWiki,
  devYourWikiRoutes,
  YourWikiApi,
  type YourWiki,
} from "./integrations/yourwiki.js";
import { linkRoutes } from "./tickets/links.js";
import { attachmentRoutes } from "./attachments/routes.js";
import { createTrash, trashRoutes } from "./tickets/trash.js";
import { tqlRoutes } from "./tickets/tql.js";
import { notificationRoutes } from "./notifications/routes.js";
import { notifier, TestChannel, type NotifyEvent } from "./notifications/service.js";
import { boardRoutes } from "./boards/routes.js";
import { ticketsChanged } from "./events.js";
import { productRoutes } from "./products.js";
import { historyService } from "./tickets/history.js";
import { numberingService } from "./tickets/numbering.js";
import { treeStore } from "./tickets/tree.js";
import { readCookie, SESSION_COOKIE, SessionStore } from "./auth/sessions.js";
import { spaceRoutes } from "./spaces/routes.js";
import { dimensionRoutes } from "./directory/dimensions.js";
import { FEATURE_TEAMS, groupRoutes, GUILDS } from "./directory/groups.js";
import { peopleRoutes } from "./directory/people.js";
import { YourSpaceCatalog, type Catalog } from "./catalog/catalog.js";
import { DevCatalog } from "./catalog/dev-catalog.js";
import { catalogRoutes } from "./catalog/routes.js";
import { CatalogSync } from "./catalog/sync.js";
import { fieldRoutes } from "./ticket-types/fields.js";
import { scaleRoutes } from "./ticket-types/scales.js";
import { typeRoutes } from "./ticket-types/types.js";
import { schemeRoutes } from "./ticket-types/schemes.js";
import { ticketRoutes } from "./tickets/routes.js";
import { historyRoutes } from "./tickets/comments.js";
import { seedTestData } from "./testing/seed.js";

export const VERSION = "0.1.0";

export interface CreateAppOptions {
  config?: AppConfig;
  /** Каталог собранного веб-интерфейса; по умолчанию apps/web/dist. */
  webRoot?: string;
  /** Подмена провайдера YourSpace (для тестов OIDC). */
  provider?: IdentityProvider;
  /** Подмена каталога YourSpace (для тестов). */
  catalog?: Catalog;
  /** Подмена запроса списка сайтов к YourSpace (для тестов переключателя). */
  productsFetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Пакет уведомлений текущего запроса. */
    notifyBuffer?: NotifyEvent[];
  }
  interface FastifyInstance {
    /** Синхронизация с каталогом YourSpace (docs/adr/0009). */
    catalogSync: CatalogSync;
    /** База приложения — для автотестов и служебных задач (пересчёт свёрток). */
    db: Database;
    /** Тестовый адаптер очереди уведомлений (вне production). */
    notificationsTest: TestChannel | null;
  }
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        'req.headers["x-yourtask-csrf"]',
        'res.headers["set-cookie"]',
      ],
      serializers: {
        // Без query string: в ней бывают одноразовые коды входа.
        req: (request) => ({
          method: request.method,
          url: request.url.split("?")[0] ?? request.url,
          remoteAddress: request.ip,
        }),
      },
    },
  });

  const db = openDatabase(config.databasePath);
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const beforeClose: (() => Promise<void>)[] = [];
  app.addHook("onClose", async () => {
    for (const task of beforeClose) await task();
    db.close();
  });
  const orm = createOrm(db);
  if (config.seedTestData) seedTestData(db);
  // Номера в потоке: первое заполнение после миграции (YT-11, docs/adr/0017).
  numberingService(db, treeStore(db), historyService(db)).ensure();

  registerErrorHandling(app);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "YourTask API",
        version: VERSION,
        description:
          "Every YourTask client (web, assistant, mobile) works through this API. " +
          "Errors use RFC 9457 Problem Details with a machine-readable `code`. " +
          "Mutations require the `x-yourtask-csrf` header from `GET /api/v1/me`.",
      },
      tags: [
        { name: "auth", description: "Sign-in with a YourSpace account" },
        { name: "me", description: "Profile and sessions" },
        { name: "spaces", description: "Spaces" },
        { name: "people", description: "People directory" },
        { name: "guilds", description: "Guilds (with a lead)" },
        { name: "feature-teams", description: "Feature teams (with a PM)" },
        { name: "dimensions", description: "Dimensions for filters and boards" },
        { name: "history", description: "Append-only change log and status sequence for metrics" },
        { name: "comments", description: "Comments with mentions; making a task from a comment" },
        { name: "tickets", description: "Tickets: key, fields, description, checklist, people, status, archive" },
        { name: "ticket-types", description: "Ticket types, status schemes, templates and subordination rules" },
        { name: "fields", description: "Ticket fields" },
        { name: "estimates", description: "Estimate scales, converter and rollup in a chosen scale" },
        { name: "catalog", description: "YourSpace people catalog: matching report and export for profiles" },
        { name: "admin", description: "Administration" },
        { name: "system", description: "Service endpoints" },
      ],
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE },
          catalogExport: {
            type: "http",
            scheme: "bearer",
            description: "YOURTASK_CATALOG_EXPORT_TOKEN, for YourSpace reading guilds and teams",
          },
        },
      },
      security: [{ session: [] }],
    },
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, index) => (json.$id as string) ?? `def-${index}` },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/api/docs" });
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  const sessions = new SessionStore(orm, config.secretKey, config.sessionTtlHours);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/api/")) request.auth = sessions.resolve(readCookie(request, SESSION_COOKIE));
  });
  // Пакет уведомлений на запрос (R-2.27, docs/adr/0024): события копятся до ответа; удачный ответ — одно
  // сообщение на получателя и вид, ошибка — ничего (транзакция откатилась, и рассказывать не о чем).
  const notifications = notifier(db);
  app.addHook("onRequest", (request, _reply, done) => {
    if (!request.url.startsWith("/api/") || request.method === "GET") return done();
    const buffer: NotifyEvent[] = [];
    request.notifyBuffer = buffer;
    notifications.enter(buffer, done);
  });
  app.addHook("onResponse", async (request, reply) => {
    const buffer = request.notifyBuffer;
    if (!buffer?.length) return;
    request.notifyBuffer = [];
    if (reply.statusCode < 400) notifications.flush(buffer);
  });
  // Любое удачное изменение через API — сигнал «тикеты поменялись» для живых досок (docs/adr/0022).
  app.addHook("onResponse", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || reply.statusCode >= 400) return;
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/v1/") || path.startsWith("/api/v1/auth") || path.endsWith("/prefs")) return;
    ticketsChanged(db, request.auth?.user.id ?? null);
  });

  let provider = options.provider;
  let devCatalog: DevCatalog | undefined;
  if (!provider) {
    if (config.yourspace.mode === "dev") {
      devCatalog = new DevCatalog(db);
      provider = new DevYourSpace(devCatalog);
    } else {
      provider = new OidcYourSpace(config.yourspace);
    }
  }
  if (provider instanceof DevYourSpace) {
    devCatalog = provider.catalog;
    await app.register(devYourSpaceRoutes, { provider });
  }
  const catalog =
    options.catalog ??
    devCatalog ??
    (config.yourspace.mode === "oidc" ? new YourSpaceCatalog(config.yourspace) : new DevCatalog(db));

  const catalogSync = new CatalogSync({
    db,
    catalog,
    logger: app.log,
    superadminEmails: config.superadminEmails,
    revokeSessions: (userId) => sessions.revokeAll(userId),
  });
  app.decorate("catalogSync", catalogSync);
  app.decorate("db", db);
  // Первая синхронизация до приёма запросов; недоступный YourSpace не мешает запуску (ошибка — в лог и в отчёт).
  await catalogSync.sync().catch(() => undefined);
  if (catalog instanceof DevCatalog) catalog.onChange(() => void catalogSync.sync().catch(() => undefined));
  app.addHook("onReady", async () => catalogSync.start(config.catalogPollSeconds));
  beforeClose.push(() => catalogSync.stop());

  app.get(
    "/health",
    {
      schema: {
        tags: ["system"],
        summary: "Liveness and database check",
        security: [],
        response: {
          200: {
            type: "object",
            required: ["status", "version", "database"],
            properties: { status: { type: "string" }, version: { type: "string" }, database: { type: "string" } },
          },
          ...problemResponses,
        },
      },
    },
    async () => {
      db.prepare("SELECT 1").get();
      return { status: "ok", version: VERSION, database: "ok" };
    },
  );

  app.post(
    "/api/v1/client-errors",
    {
      bodyLimit: 16 * 1024,
      schema: {
        tags: ["system"],
        summary: "Report an error that happened in a client",
        security: [],
        body: {
          type: "object",
          required: ["message"],
          additionalProperties: false,
          properties: {
            message: { type: "string", maxLength: 2000 },
            stack: { type: "string", maxLength: 8000 },
            url: { type: "string", maxLength: 2000 },
            client: { type: "string", maxLength: 50 },
          },
        },
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      request.log.warn({ clientError: request.body, userId: request.auth?.user.id }, "Client error reported");
      return reply.code(204).send();
    },
  );

  await app.register(authRoutes, { db, config, orm, provider, sessions, catalog: catalogSync });
  await app.register(accessRoutes, { db, sessions });
  await app.register(spaceRoutes, { db });
  await app.register(peopleRoutes, { db, catalog: catalogSync });
  await app.register(catalogRoutes, { db, sync: catalogSync, exportToken: config.catalogExportToken });
  await app.register(groupRoutes(GUILDS), { db });
  await app.register(groupRoutes(FEATURE_TEAMS), { db });
  await app.register(dimensionRoutes, { db });
  await app.register(scaleRoutes, { db });
  await app.register(fieldRoutes, { db });
  await app.register(typeRoutes, { db });
  await app.register(schemeRoutes, { db });
  await app.register(ticketRoutes, { db, keyPrefix: config.ticketKeyPrefix });
  await app.register(historyRoutes, { db, keyPrefix: config.ticketKeyPrefix });
  // YourWiki (YT-12, docs/adr/0018): заглушка в разработке, API по контракту WK-02 в бою.
  const wiki: YourWiki | null =
    config.yourwiki.mode === "dev"
      ? new DevYourWiki(db, `${config.publicUrl}${DEV_YOURWIKI_PATH}`)
      : config.yourwiki.mode === "api"
        ? new YourWikiApi(config.yourwiki.url)
        : null;
  if (wiki instanceof DevYourWiki) {
    const dev = provider instanceof DevYourSpace ? provider : null;
    await app.register(devYourWikiRoutes, { db, wiki, userinfo: (token) => dev?.userinfo(token) ?? null });
  }
  await app.register(attachmentRoutes, { db, root: config.attachmentsPath, keyPrefix: config.ticketKeyPrefix });
  // Корзина и след родителя (YT-14, docs/adr/0020): очистка по сроку — системным правилом.
  const trash = createTrash(db, config.ticketKeyPrefix, config.attachmentsPath);
  app.decorate("trash", trash);
  await app.register(trashRoutes, { service: trash, sweepMs: config.trashSweepMinutes * 60_000 });
  // TQL, полнотекст и сохранённые фильтры (YT-15, docs/adr/0021).
  await app.register(tqlRoutes, { db, keyPrefix: config.ticketKeyPrefix });
  // Уведомления и очередь событий (YT-18, docs/adr/0024): колокольчик — канал очереди; вне production — ещё
  // тестовый адаптер, который получает те же сообщения.
  const testChannel = config.profile === "production" ? null : new TestChannel();
  if (testChannel) notifier(db).register(testChannel);
  app.decorate("notificationsTest", testChannel);
  await app.register(notificationRoutes, { db, testChannel, retryMs: 60_000 });
  // Доски и зоны, живые изменения (YT-16, docs/adr/0022).
  await app.register(boardRoutes, { db, keyPrefix: config.ticketKeyPrefix });
  // Переключатель сайтов YourSpace (docs/site-switcher.md в YourSpace).
  await app.register(productRoutes, {
    yourspaceUrl: config.yourspaceUrl,
    publicUrl: config.publicUrl,
    siteUrls: config.siteUrls,
    devStub: provider instanceof DevYourSpace,
    ...(options.productsFetch ? { fetch: options.productsFetch } : {}),
  });
  await app.register(linkRoutes, {
    db,
    keyPrefix: config.ticketKeyPrefix,
    wiki,
    linkPreviewPrivate: config.linkPreviewPrivate,
    sessions,
  });

  const webRoot = options.webRoot ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const serveWeb = existsSync(webRoot);
  if (serveWeb) await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    const isPageNavigation =
      serveWeb &&
      request.method === "GET" &&
      !request.url.startsWith("/api/") &&
      request.headers.accept?.includes("text/html") === true;
    if (isPageNavigation) return reply.sendFile("index.html");
    return sendProblem(
      request,
      reply,
      404,
      "not_found",
      `Route ${request.method} ${request.url.split("?")[0]} not found`,
    );
  });

  return app;
}
