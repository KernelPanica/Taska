import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, ne, or, isNotNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { CSRF_HEADER, type LoginMethod, type SessionInfo } from "@yourtask/contracts";
import type { Orm } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { AppError } from "../errors.js";

export const SESSION_COOKIE = "yourtask_session";
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Человек, глазами которого отвечает API. В «Смотреть как» и «Режиме показа» (docs/adr/0014) это не тот,
 * кто вошёл: при взгляде роли — сам человек без роли суперадмина и с профилем-линзой, при взгляде человека — тот человек.
 */
export type UserRow = typeof users.$inferSelect & { lensProfileId?: string | null };
export type SessionRow = typeof sessions.$inferSelect;

export interface Auth {
  session: SessionRow;
  /** Чьими глазами отвечает API (с учётом «Смотреть как»). */
  user: UserRow;
  /** Кто вошёл на самом деле. */
  realUser: UserRow;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class SessionStore {
  constructor(
    private readonly orm: Orm,
    private readonly secretKey: string,
    private readonly ttlHours: number,
  ) {}

  private hash(token: string) {
    return createHmac("sha256", this.secretKey).update(token).digest("base64url");
  }

  /** Ключ шифрования токенов YourSpace в сессиях — производный от секрета сервера. */
  private tokenKey() {
    return createHash("sha256").update(`${this.secretKey}:yourspace-token`).digest();
  }

  private seal(token: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.tokenKey(), iv);
    const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
  }

  /** Токен доступа YourSpace этой сессии, пока он не истёк; иначе null. */
  yourspaceToken(session: SessionRow): string | null {
    if (!session.yourspaceToken || !session.yourspaceTokenExpiresAt || session.yourspaceTokenExpiresAt <= Date.now())
      return null;
    try {
      const [iv, tag, data] = session.yourspaceToken.split(".").map((part) => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.tokenKey(), iv as Buffer);
      decipher.setAuthTag(tag as Buffer);
      return Buffer.concat([decipher.update(data as Buffer), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  create(input: {
    userId: string;
    method: LoginMethod;
    mfa: boolean;
    userAgent?: string | undefined;
    ip?: string;
    yourspaceToken?: string | undefined;
    yourspaceTokenExpiresAt?: number | undefined;
  }) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.ttlHours * 3_600_000;
    this.orm
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, now), isNotNull(sessions.revokedAt)))
      .run();
    this.orm
      .insert(sessions)
      .values({
        id: randomBytes(16).toString("hex"),
        userId: input.userId,
        tokenHash: this.hash(token),
        csrfToken: randomBytes(32).toString("base64url"),
        method: input.method,
        mfa: input.mfa,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        ip: input.ip ?? null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        yourspaceToken: input.yourspaceToken ? this.seal(input.yourspaceToken) : null,
        yourspaceTokenExpiresAt: input.yourspaceToken ? (input.yourspaceTokenExpiresAt ?? null) : null,
      })
      .run();
    return { token, maxAgeSeconds: Math.floor((expiresAt - now) / 1000) };
  }

  /** Активная сессия по токену из cookie или null (отозванные и истёкшие — не активны). */
  resolve(token: string | undefined): Auth | null {
    if (!token) return null;
    const row = this.orm
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, this.hash(token)))
      .get();
    const now = Date.now();
    if (!row || row.session.revokedAt !== null || row.session.expiresAt <= now) return null;
    // Деактивированный в каталоге человек не входит, даже если сессию не успели отозвать (R-2.2).
    if (row.user.deactivatedAt !== null) return null;
    if (now - row.session.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.orm.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id)).run();
      row.session.lastSeenAt = now;
    }
    return { session: row.session, realUser: row.user, user: this.lensUser(row.session, row.user) };
  }

  /** Зритель с учётом «Смотреть как» / «Режима показа». Линза на недоступного человека снимается. */
  private lensUser(session: SessionRow, user: UserRow): UserRow {
    if (session.lensKind === "profile" && session.lensId) {
      return { ...user, role: "member", lensProfileId: session.lensId };
    }
    if (session.lensKind === "person" && session.lensId && user.role === "superadmin") {
      const target = this.orm.select().from(users).where(eq(users.id, session.lensId)).get();
      if (target && target.deactivatedAt === null) return target;
    }
    if (session.lensKind) {
      this.orm
        .update(sessions)
        .set({ lensKind: null, lensId: null, lensShow: false })
        .where(eq(sessions.id, session.id))
        .run();
      session.lensKind = null;
      session.lensId = null;
      session.lensShow = false;
    }
    return user;
  }

  setLens(sessionId: string, lens: { kind: "profile" | "person"; id: string; show: boolean } | null) {
    this.orm
      .update(sessions)
      .set({ lensKind: lens?.kind ?? null, lensId: lens?.id ?? null, lensShow: lens?.show ?? false })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  list(userId: string, currentId: string): SessionInfo[] {
    return this.orm
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .all()
      .filter((session) => session.expiresAt > Date.now())
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((session) => ({
        id: session.id,
        current: session.id === currentId,
        method: session.method,
        mfa: session.mfa,
        userAgent: session.userAgent,
        ip: session.ip,
        createdAt: new Date(session.createdAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
      }));
  }

  revoke(userId: string, sessionId: string): boolean {
    const result = this.orm
      .update(sessions)
      .set({ revokedAt: Date.now() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .run();
    return result.changes > 0;
  }

  revokeAll(userId: string, exceptSessionId?: string): number {
    const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
    return this.orm
      .update(sessions)
      .set({ revokedAt: Date.now() })
      .where(and(...conditions))
      .run().changes;
  }
}

/** Требует вход; для изменяющих запросов дополнительно проверяет CSRF-заголовок. */
export function requireAuth(request: FastifyRequest): Auth {
  const auth = request.auth;
  if (!auth) throw new AppError(401, "unauthenticated", "Sign in with your YourSpace account");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const header = request.headers[CSRF_HEADER];
    if (typeof header !== "string" || !safeEqual(header, auth.session.csrfToken)) {
      throw new AppError(403, "csrf_invalid", `Send the ${CSRF_HEADER} header from GET /api/v1/me`);
    }
    // Глазами другого человека только смотрят: менять от его имени нельзя (docs/adr/0014).
    const path = request.url.split("?")[0] ?? "";
    if (auth.session.lensKind === "person" && !path.startsWith("/api/v1/me") && !path.startsWith("/api/v1/auth/")) {
      throw new AppError(
        403,
        "view_as_read_only",
        "You are looking through another person's eyes. Leave «View as» to make changes.",
      );
    }
  }
  return auth;
}

/** Администратор с подтверждённой второй проверкой в этой сессии (R-2.1, docs/adr/0003). */
export function requireSuperadmin(request: FastifyRequest): Auth {
  const auth = requireAuth(request);
  if (auth.user.role !== "superadmin") throw new AppError(403, "forbidden", "Superadmin role required");
  if (!auth.session.mfa) throw new AppError(403, "mfa_required", "Sign in again with a second factor");
  return auth;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean) {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
