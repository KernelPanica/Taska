import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { CATALOG_MATCHES, type CatalogResolution } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireSuperadmin } from "../auth/sessions.js";
import { personRefSchema } from "../directory/common.js";
import { CatalogError } from "./catalog.js";
import type { CatalogSync } from "./sync.js";

interface CatalogRouteOptions {
  db: Database;
  sync: CatalogSync;
  /** Токен, с которым YourSpace читает колодцы и фичекоманды; пусто — выгрузка выключена. */
  exportToken: string;
}

const countsSchema = {
  type: "object",
  required: [...CATALOG_MATCHES],
  properties: Object.fromEntries(CATALOG_MATCHES.map((match) => [match, { type: "integer" }])),
} as const;

const reportSchema = {
  type: "object",
  required: ["lastSyncAt", "lastError", "counts", "rows"],
  properties: {
    lastSyncAt: { type: ["string", "null"], format: "date-time" },
    lastError: { type: ["string", "null"] },
    counts: countsSchema,
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["person", "match", "catalogId", "candidates"],
        properties: {
          person: personRefSchema,
          match: { type: "string", enum: CATALOG_MATCHES },
          catalogId: { type: ["string", "null"] },
          candidates: {
            type: "array",
            items: {
              type: "object",
              required: ["catalogId", "name", "email"],
              properties: {
                catalogId: { type: "string" },
                name: { type: "string" },
                email: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
} as const;

const groupOrgSchema = {
  type: "object",
  required: ["id", "name", "head", "isHead"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    head: {
      anyOf: [
        {
          type: "object",
          required: ["catalogId", "name"],
          properties: { catalogId: { type: ["string", "null"] }, name: { type: "string" } },
        },
        { type: "null" },
      ],
    },
    isHead: { type: "boolean", description: "This person is the guild lead / the team PM" },
  },
} as const;

const orgSchema = {
  type: "object",
  required: ["catalogId", "wipLimit", "guilds", "teams"],
  properties: {
    catalogId: { type: "string", description: "YourSpace account id (sub)" },
    wipLimit: { type: ["integer", "null"] },
    guilds: { type: "array", items: groupOrgSchema },
    teams: { type: "array", items: groupOrgSchema },
  },
} as const;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

interface OrgRow {
  catalogId: string;
  groupId: string;
  groupName: string;
  headCatalogId: string | null;
  headName: string | null;
  isHead: number;
}

/**
 * Каталог YourSpace в YourTask (docs/adr/0009):
 * - отчёт сопоставления людей и его разбор суперадмином;
 * - выгрузка колодцев, фичекоманд, лидов, ПМов и нормы WIP для блока «Из YourTask» в профиле YourSpace (R-2.2).
 */
export const catalogRoutes: FastifyPluginAsync<CatalogRouteOptions> = async (app, { db, sync, exportToken }) => {
  app.get(
    "/api/v1/catalog/report",
    {
      schema: {
        tags: ["catalog"],
        summary: "Matching report: how YourTask people map to the YourSpace catalog (superadmin)",
        response: { 200: reportSchema, ...problemResponses },
      },
    },
    async (request) => sync.report(requireSuperadmin(request).user),
  );

  app.post(
    "/api/v1/catalog/sync",
    {
      schema: {
        tags: ["catalog"],
        summary: "Re-read the whole YourSpace catalog now (superadmin)",
        response: { 200: reportSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      try {
        await sync.resync();
      } catch (error) {
        if (error instanceof CatalogError) throw new AppError(503, "catalog_unavailable", error.message);
        throw error;
      }
      return sync.report(user);
    },
  );

  app.post(
    "/api/v1/catalog/report/:userId/resolve",
    {
      schema: {
        tags: ["catalog"],
        summary: "Resolve a report row: link to a catalog account or mark as not in the catalog (superadmin)",
        params: { type: "object", required: ["userId"], properties: { userId: { type: "string", maxLength: 64 } } },
        // Одна схема вместо oneOf: removeAdditional в Ajv срезает поля при проверке «чужой» ветки oneOf.
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["link", "retire"], description: "link needs catalogId" },
            catalogId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        response: { 200: reportSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { user } = requireSuperadmin(request);
      const { userId } = request.params as { userId: string };
      const body = request.body as { action: "link" | "retire"; catalogId?: string };
      if (body.action === "link" && !body.catalogId) {
        throw new AppError(400, "validation_failed", "catalogId is required to link", [
          { field: "catalogId", message: "is required for action link" },
        ]);
      }
      const resolution: CatalogResolution =
        body.action === "link" ? { action: "link", catalogId: body.catalogId as string } : { action: "retire" };
      await sync.resolve(user, userId, resolution);
      request.log.info({ adminId: user.id, userId, action: resolution.action }, "Catalog report row resolved");
      return sync.report(user);
    },
  );

  // ---- выгрузка для YourSpace ----------------------------------------------------------------

  const expected = exportToken ? sha256(exportToken) : null;
  function requireExportToken(request: FastifyRequest) {
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!expected || !token || !timingSafeEqual(sha256(token), expected)) {
      throw new AppError(401, "unauthenticated", "A valid YourTask catalog export token is required");
    }
  }

  const orgRows = (table: string, members: string, column: string, headColumn: string, subject?: string) =>
    db
      .prepare(
        `SELECT u.yourspace_subject AS catalogId, g.id AS groupId, g.name AS groupName,
                h.yourspace_subject AS headCatalogId, h.name AS headName, g.${headColumn} = u.id AS isHead
         FROM ${members} m
         JOIN ${table} g ON g.id = m.${column} AND g.is_test = 0
         JOIN users u ON u.id = m.user_id AND u.is_test = 0 AND u.yourspace_subject IS NOT NULL
         LEFT JOIN users h ON h.id = g.${headColumn}
         ${subject ? "WHERE u.yourspace_subject = ?" : ""}
         UNION
         SELECT u.yourspace_subject, g.id, g.name, u.yourspace_subject, u.name, 1
         FROM ${table} g JOIN users u ON u.id = g.${headColumn} AND u.is_test = 0 AND u.yourspace_subject IS NOT NULL
         WHERE g.is_test = 0 ${subject ? "AND u.yourspace_subject = ?" : ""}`,
      )
      .all(...(subject ? [subject, subject] : [])) as OrgRow[];

  function org(subject?: string) {
    const people = db
      .prepare(
        `SELECT yourspace_subject AS catalogId, wip_limit AS wipLimit FROM users
         WHERE is_test = 0 AND yourspace_subject IS NOT NULL ${subject ? "AND yourspace_subject = ?" : ""}
         ORDER BY yourspace_subject`,
      )
      .all(...(subject ? [subject] : [])) as { catalogId: string; wipLimit: number | null }[];
    const group = (rows: OrgRow[]) => {
      const map = new Map<string, Map<string, OrgRow>>();
      for (const row of rows) {
        const forPerson = map.get(row.catalogId) ?? new Map<string, OrgRow>();
        const existing = forPerson.get(row.groupId);
        // Лид может не входить в состав: строки «состав» и «глава» сливаем.
        forPerson.set(row.groupId, existing ? { ...existing, isHead: existing.isHead || row.isHead } : row);
        map.set(row.catalogId, forPerson);
      }
      return (catalogId: string) =>
        [...(map.get(catalogId)?.values() ?? [])]
          .sort((a, b) => a.groupName.localeCompare(b.groupName, "ru"))
          .map((row) => ({
            id: row.groupId,
            name: row.groupName,
            head: row.headName === null ? null : { catalogId: row.headCatalogId, name: row.headName },
            isHead: Boolean(row.isHead),
          }));
    };
    const guilds = group(orgRows("guilds", "guild_members", "guild_id", "lead_id", subject));
    const teams = group(orgRows("feature_teams", "feature_team_members", "team_id", "pm_id", subject));
    return people.map((person) => ({ ...person, guilds: guilds(person.catalogId), teams: teams(person.catalogId) }));
  }

  const exportSecurity = [{ catalogExport: [] }];

  app.get(
    "/api/v1/catalog/org",
    {
      schema: {
        tags: ["catalog"],
        summary: "Guilds, feature teams, leads, PMs and WIP limits of every person, for the YourSpace profile",
        description:
          "Read by YourSpace with `Authorization: Bearer <YOURTASK_CATALOG_EXPORT_TOKEN>`. Test data is excluded.",
        security: exportSecurity,
        response: {
          200: { type: "object", required: ["items"], properties: { items: { type: "array", items: orgSchema } } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      requireExportToken(request);
      return { items: org() };
    },
  );

  app.get(
    "/api/v1/catalog/org/:catalogId",
    {
      schema: {
        tags: ["catalog"],
        summary: "Guilds, feature teams and WIP limit of one person, by YourSpace account id",
        security: exportSecurity,
        params: {
          type: "object",
          required: ["catalogId"],
          properties: { catalogId: { type: "string", maxLength: 100 } },
        },
        response: { 200: orgSchema, ...problemResponses },
      },
    },
    async (request) => {
      requireExportToken(request);
      const [person] = org((request.params as { catalogId: string }).catalogId);
      if (!person) throw new AppError(404, "not_found", "Person not found");
      return person;
    },
  );
};
