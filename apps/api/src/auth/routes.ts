import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { LOCALES, type ErrorCode, type LoginMethod, type Me } from "@yourtask/contracts";
import type { AppConfig } from "../config.js";
import type { Database, Orm } from "../db/index.js";
import { authFlows, users } from "../db/schema.js";
import { AppError, problemResponses } from "../errors.js";
import { provisionUser, setLocale, toUser } from "../users/service.js";
import type { CatalogSync } from "../catalog/sync.js";
import { IdentityProviderError, type IdentityProvider } from "./provider.js";
import {
  clearSessionCookie,
  readCookie,
  requireSuperadmin,
  requireAuth,
  sessionCookie,
  type Auth,
  type SessionStore,
} from "./sessions.js";

interface AuthRouteOptions {
  db: Database;
  config: AppConfig;
  orm: Orm;
  provider: IdentityProvider;
  sessions: SessionStore;
  catalog: CatalogSync;
}

const FLOW_COOKIE = "yourtask_login";
const FLOW_TTL_MS = 10 * 60_000;
const CALLBACK_PATH = "/api/v1/auth/callback";

const userSchema = {
  type: "object",
  required: ["id", "email", "name", "role", "locale"],
  properties: {
    id: { type: "string" },
    email: { type: ["string", "null"] },
    name: { type: "string" },
    role: { type: "string", enum: ["superadmin", "member"] },
    locale: { type: "string", enum: LOCALES },
  },
} as const;

const meSchema = {
  type: "object",
  required: ["user", "csrfToken", "session", "lens", "showProfileId", "canViewAsPerson"],
  properties: {
    user: userSchema,
    lens: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          required: ["kind", "id", "name", "show"],
          properties: {
            kind: { type: "string", enum: ["profile", "person"] },
            id: { type: "string" },
            name: { type: "string" },
            show: { type: "boolean" },
          },
        },
      ],
    },
    showProfileId: { anyOf: [{ type: "null" }, { type: "string" }] },
    canViewAsPerson: { type: "boolean" },
    csrfToken: { type: "string", description: "Send it in the x-yourtask-csrf header with every mutation." },
    session: {
      type: "object",
      required: ["id", "method", "mfa", "expiresAt"],
      properties: {
        id: { type: "string" },
        method: { type: "string", enum: ["password", "google"] },
        mfa: { type: "boolean" },
        expiresAt: { type: "string", format: "date-time" },
      },
    },
  },
} as const;

const sessionInfoSchema = {
  type: "object",
  required: ["id", "current", "method", "mfa", "userAgent", "ip", "createdAt", "lastSeenAt", "expiresAt"],
  properties: {
    id: { type: "string" },
    current: { type: "boolean" },
    method: { type: "string", enum: ["password", "google"] },
    mfa: { type: "boolean" },
    userAgent: { type: ["string", "null"] },
    ip: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    lastSeenAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

/** Только относительные пути внутри приложения — защита от открытого редиректа. */
function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (value.startsWith("/api/") || value.startsWith("/dev/")) return "/";
  return value.slice(0, 500);
}

/** Профиль сессии; lens — «Смотреть как» / «Режим показа» (docs/adr/0014). */
export function toMe(auth: Auth, db: Database): Me {
  const lensName =
    auth.session.lensKind === "person"
      ? auth.user.name
      : auth.session.lensKind === "profile" && auth.session.lensId
        ? ((
            db.prepare("SELECT name FROM access_profiles WHERE id = ?").get(auth.session.lensId) as
              | { name: string }
              | undefined
          )?.name ?? "")
        : null;
  return {
    user: toUser(auth.realUser),
    lens:
      auth.session.lensKind && auth.session.lensId && lensName !== null
        ? { kind: auth.session.lensKind, id: auth.session.lensId, name: lensName, show: auth.session.lensShow }
        : null,
    showProfileId: auth.realUser.showProfileId ?? null,
    canViewAsPerson: auth.realUser.role === "superadmin",
    csrfToken: auth.session.csrfToken,
    session: {
      id: auth.session.id,
      method: auth.session.method,
      mfa: auth.session.mfa,
      expiresAt: new Date(auth.session.expiresAt).toISOString(),
    },
  };
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (
  app,
  { db, config, orm, provider, sessions, catalog },
) => {
  const redirectUri = provider.kind === "dev" ? CALLBACK_PATH : `${config.publicUrl}${CALLBACK_PATH}`;
  const flowCookie = (value: string, maxAge: number) =>
    `${FLOW_COOKIE}=${value}; Max-Age=${maxAge}; Path=/api/v1/auth; HttpOnly; SameSite=Lax${config.secureCookies ? "; Secure" : ""}`;

  async function startFlow(reply: FastifyReply, method: LoginMethod, returnTo: string, requireMfa: boolean) {
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const now = Date.now();
    orm.delete(authFlows).where(lt(authFlows.expiresAt, now)).run();
    orm
      .insert(authFlows)
      .values({
        stateHash: hash(state),
        nonce,
        codeVerifier,
        method,
        requireMfa,
        returnTo,
        createdAt: now,
        expiresAt: now + FLOW_TTL_MS,
      })
      .run();
    let location: string;
    try {
      location = await provider.authorizationUrl({
        state,
        nonce,
        codeChallenge: hash(codeVerifier),
        redirectUri,
        method,
        requireMfa,
      });
    } catch (error) {
      reply.log.error({ err: error }, "YourSpace authorization URL failed");
      return failLogin(reply, "identity_provider_error");
    }
    return reply.header("Set-Cookie", flowCookie(state, FLOW_TTL_MS / 1000)).redirect(location, 302);
  }

  function failLogin(reply: FastifyReply, code: ErrorCode) {
    return reply.header("Set-Cookie", flowCookie("", 0)).redirect(`/login?error=${code}`, 302);
  }

  app.get(
    "/api/v1/auth/login",
    {
      schema: {
        tags: ["auth"],
        summary: "Start sign-in with a YourSpace account",
        description:
          "Browser navigation endpoint. Redirects to YourSpace (login and password, or the linked Google account). " +
          "YourTask never receives or stores the password.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            method: { type: "string", enum: ["password", "google"], default: "password" },
            returnTo: { type: "string", maxLength: 500 },
          },
        },
        response: { 302: { type: "null", description: "Redirect to YourSpace" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const query = request.query as { method: LoginMethod; returnTo?: string };
      return startFlow(reply, query.method, safeReturnTo(query.returnTo), false);
    },
  );

  app.get(
    CALLBACK_PATH,
    {
      schema: {
        tags: ["auth"],
        summary: "YourSpace redirects back here",
        description:
          "Exchanges the one-time code (PKCE), provisions the user, enforces the administrator second factor, " +
          "creates a session and redirects to the app. Failures redirect to /login?error=<code>.",
        querystring: {
          type: "object",
          properties: { code: { type: "string" }, state: { type: "string" }, error: { type: "string" } },
        },
        response: { 302: { type: "null" } },
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
      const cookieState = readCookie(request, FLOW_COOKIE);
      if (!state || !cookieState || cookieState !== state) return failLogin(reply, "login_expired");

      const flow = orm
        .select()
        .from(authFlows)
        .where(eq(authFlows.stateHash, hash(state)))
        .get();
      orm
        .delete(authFlows)
        .where(eq(authFlows.stateHash, hash(state)))
        .run();
      if (!flow || flow.expiresAt < Date.now()) return failLogin(reply, "login_expired");
      if (error) return failLogin(reply, error === "mfa_unavailable" ? "mfa_required" : "login_failed");
      if (!code) return failLogin(reply, "login_failed");

      let identity;
      try {
        identity = await provider.exchange({ code, codeVerifier: flow.codeVerifier, redirectUri, nonce: flow.nonce });
      } catch (exchangeError) {
        if (exchangeError instanceof IdentityProviderError && exchangeError.rejected) {
          request.log.info({ reason: exchangeError.message }, "YourSpace sign-in rejected");
          return failLogin(reply, "login_failed");
        }
        request.log.error({ err: exchangeError }, "YourSpace code exchange failed");
        return failLogin(reply, "identity_provider_error");
      }

      try {
        // Свежий профиль из каталога: новый участник входит сразу, деактивированный — нет.
        await catalog.refresh(identity.subject);
      } catch (catalogError) {
        request.log.warn({ err: catalogError }, "Catalog refresh before sign-in failed");
      }

      let user;
      try {
        user = provisionUser(orm, identity, config.superadminEmails);
      } catch (provisionError) {
        if (provisionError instanceof AppError) {
          request.log.warn({ subject: identity.subject, code: provisionError.code }, provisionError.message);
          return failLogin(reply, provisionError.code);
        }
        throw provisionError;
      }
      if (user.deactivatedAt !== null) {
        request.log.warn({ userId: user.id }, "Sign-in of a deactivated person was refused");
        return failLogin(reply, "account_deactivated");
      }
      if (user.role === "superadmin" && !identity.mfa) {
        // Администратору нужна вторая проверка: просим YourSpace о step-up один раз.
        if (!flow.requireMfa) return startFlow(reply, flow.method, flow.returnTo, true);
        request.log.warn({ userId: user.id }, "Superadmin sign-in without a second factor was refused");
        return failLogin(reply, "mfa_required");
      }

      const session = sessions.create({
        userId: user.id,
        method: identity.method,
        mfa: identity.mfa,
        userAgent: request.headers["user-agent"],
        ip: request.ip,
        yourspaceToken: identity.accessToken,
        yourspaceTokenExpiresAt: identity.accessTokenExpiresAt,
      });
      request.log.info({ userId: user.id, method: identity.method, mfa: identity.mfa }, "Signed in");
      return reply
        .header("Set-Cookie", [
          sessionCookie(session.token, session.maxAgeSeconds, config.secureCookies),
          flowCookie("", 0),
        ])
        .redirect(flow.returnTo, 302);
    },
  );

  app.post(
    "/api/v1/auth/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Sign out (revokes the current session)",
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      sessions.revoke(auth.realUser.id, auth.session.id);
      return reply.header("Set-Cookie", clearSessionCookie(config.secureCookies)).code(204).send();
    },
  );

  app.get(
    "/api/v1/me",
    {
      schema: {
        tags: ["me"],
        summary: "Current user, session and CSRF token",
        response: { 200: meSchema, ...problemResponses },
      },
    },
    async (request) => toMe(requireAuth(request), db),
  );

  app.patch(
    "/api/v1/me",
    {
      schema: {
        tags: ["me"],
        summary: "Update profile preferences (interface language)",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["locale"],
          properties: { locale: { type: "string", enum: LOCALES } },
        },
        response: { 200: meSchema, ...problemResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { locale } = request.body as { locale: (typeof LOCALES)[number] };
      return toMe({ ...auth, realUser: setLocale(orm, auth.realUser.id, locale) }, db);
    },
  );

  app.get(
    "/api/v1/me/sessions",
    {
      schema: {
        tags: ["me"],
        summary: "Active sessions of the current user",
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: sessionInfoSchema } },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return { items: sessions.list(auth.realUser.id, auth.session.id) };
    },
  );

  app.delete(
    "/api/v1/me/sessions/:sessionId",
    {
      schema: {
        tags: ["me"],
        summary: "Revoke one of my sessions",
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", maxLength: 64 } },
        },
        response: { 204: { type: "null" }, ...problemResponses },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { sessionId } = request.params as { sessionId: string };
      if (!sessions.revoke(auth.realUser.id, sessionId)) throw new AppError(404, "not_found", "Session not found");
      if (sessionId === auth.session.id) reply.header("Set-Cookie", clearSessionCookie(config.secureCookies));
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/me/sessions/revoke-others",
    {
      schema: {
        tags: ["me"],
        summary: "Revoke all my sessions except the current one",
        response: {
          200: { type: "object", required: ["revoked"], properties: { revoked: { type: "integer" } } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return { revoked: sessions.revokeAll(auth.realUser.id, auth.session.id) };
    },
  );

  app.post(
    "/api/v1/admin/users/:userId/sessions/revoke",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke every session of a user (administrator, second factor required)",
        params: { type: "object", required: ["userId"], properties: { userId: { type: "string", maxLength: 64 } } },
        response: {
          200: { type: "object", required: ["revoked"], properties: { revoked: { type: "integer" } } },
          ...problemResponses,
        },
      },
    },
    async (request: FastifyRequest) => {
      const auth = requireSuperadmin(request);
      const { userId } = request.params as { userId: string };
      const target = orm
        .select()
        .from(users)
        .where(auth.user.isTest ? eq(users.id, userId) : and(eq(users.id, userId), eq(users.isTest, false)))
        .get();
      if (!target) throw new AppError(404, "not_found", "User not found");
      const revoked = sessions.revokeAll(target.id);
      request.log.info({ adminId: auth.user.id, userId: target.id, revoked }, "Sessions revoked by administrator");
      return { revoked };
    },
  );
};
