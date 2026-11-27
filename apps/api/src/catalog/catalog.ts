import type { YourSpaceConfig } from "../config.js";

/**
 * Общий каталог людей YourSpace (R-2.2, YS-02, docs/adr/0009).
 * Протокол — `docs/connect-a-product.md` в репозитории YourSpace: список людей, профиль, лента событий.
 * YourTask читает каталог как сервер продукта (client_id/secret), поэтому чувствительные поля
 * приходят только маской; YourTask дополнительно маскирует их сам и сырых значений не хранит.
 */
export type CatalogRole = "superadmin" | "admin" | "member";
export type CatalogEventType = "created" | "updated" | "deactivated" | "reactivated";

export interface CatalogPerson {
  id: string;
  username: string;
  displayName: string;
  role: CatalogRole;
  erased?: boolean;
  active: boolean;
  deactivatedAt: number | null;
  contactEmail: string | null;
  fullName: string | null;
  nickname: string | null;
  telegram: string | null;
  vk: string | null;
  city: string | null;
  timezone: string | null;
  portfolio: string | null;
  giteaLogin: string | null;
  perforceLogin: string | null;
  availabilityHours: number | null;
  roleTitle: string | null;
  joinedAt: string | null;
  membershipStatus: string | null;
  tenure: { months: number; text: string; frozen: boolean } | null;
  revision: number;
}

/** Профиль глазами сервера продукта: чувствительные поля — маской. */
export interface CatalogProfileData extends CatalogPerson {
  extraEmail: string | null;
  phone: string | null;
  birthDate: string | null;
  comments: string | null;
  unavailabilityRisk: string | null;
  masked: string[];
}

export interface CatalogEvent {
  id: number;
  userId: string;
  type: CatalogEventType;
  createdAt: number;
}

export interface Catalog {
  readonly kind: "dev" | "yourspace";
  /** Все люди, включая деактивированных. */
  list(): Promise<CatalogPerson[]>;
  /** Профиль или null, если такого аккаунта нет. */
  profile(id: string): Promise<CatalogProfileData | null>;
  events(after: number): Promise<{ items: CatalogEvent[]; next: number }>;
  /** Где человек и суперадмин правят профиль и видят поля без маски. */
  profileUrl(id: string): string;
}

export class CatalogError extends Error {
  override name = "CatalogError";
}

export const SENSITIVE_FIELDS = ["phone", "extraEmail", "birthDate", "comments", "unavailabilityRisk"] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

/**
 * Маска как в YourSpace: телефон «+… 42», почта «a…@domain», остальное «…».
 * Идемпотентна: маска от маски даёт ту же маску, поэтому применяем её всегда.
 */
export function maskValue(field: SensitiveField, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (field === "phone") {
    const digits = text.replace(/\D/g, "");
    return `${text.trim().startsWith("+") ? "+" : ""}… ${digits.slice(-2)}`;
  }
  if (field === "extraEmail") {
    const [name, domain] = text.split("@");
    return `${name?.[0] ?? ""}…@${domain ?? "…"}`;
  }
  return "…";
}

type OidcConfig = Extract<YourSpaceConfig, { mode: "oidc" }>;

/** HTTP-клиент каталога YourSpace. */
export class YourSpaceCatalog implements Catalog {
  readonly kind = "yourspace" as const;

  constructor(
    private readonly config: OidcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  private async get<T>(path: string, allowNotFound = false): Promise<T | null> {
    const credentials = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.issuer}${path}`, {
        headers: { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CatalogError(`Catalog request failed: ${String(error)}`);
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new CatalogError(`Catalog ${path.split("?")[0]} returned ${response.status}`);
    return (await response.json()) as T;
  }

  async list() {
    const body = await this.get<{ items: CatalogPerson[] }>("/api/directory/people?includeInactive=1");
    return body?.items ?? [];
  }

  profile(id: string) {
    return this.get<CatalogProfileData>(`/api/directory/people/${encodeURIComponent(id)}`, true);
  }

  async events(after: number) {
    const body = await this.get<{ items: CatalogEvent[]; next: number }>(
      `/api/directory/events?after=${after}&limit=500`,
    );
    return body ?? { items: [], next: after };
  }

  profileUrl(id: string) {
    return `${this.config.issuer}/people/${encodeURIComponent(id)}`;
  }
}
