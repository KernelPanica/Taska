import { createPublicKey, verify, type JsonWebKeyInput } from "node:crypto";
import { isLocale } from "@yourtask/contracts";
import type { YourSpaceConfig } from "../config.js";
import {
  IdentityProviderError,
  type AuthorizationRequest,
  type CodeExchange,
  type Identity,
  type IdentityProvider,
} from "./provider.js";

/**
 * Вход аккаунтом YourSpace по OpenID Connect (docs/adr/0003). Протокол — `docs/connect-a-product.md`
 * в репозитории YourSpace:
 * - `yourspace_method=google` сразу ведёт на вход через Google;
 * - `acr_values=mfa` требует вторую проверку; она подтверждается `acr=mfa` или `amr` с `mfa`/`otp`;
 * - `amr` содержит `pwd` или `google` — чем человек вошёл;
 * - `yourspace_role` — общая роль (superadmin, admin, member).
 *
 * Подпись id_token (RS256) проверяется ключами из `jwks_uri`; кроме неё — iss, aud, exp и nonce.
 */
type OidcConfig = Extract<YourSpaceConfig, { mode: "oidc" }>;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

type Jwk = JsonWebKeyInput["key"] & { kid?: string; alg?: string; use?: string; kty?: string };

const MFA_AMR = new Set(["mfa", "otp", "hwk", "swk", "totp"]);
const FEDERATED_AMR = new Set(["google", "fed"]);

function decodePart(part: string | undefined): Record<string, unknown> {
  if (!part) throw new IdentityProviderError("id_token is malformed", true);
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new IdentityProviderError("id_token is malformed", true);
  }
}

export class OidcYourSpace implements IdentityProvider {
  readonly kind = "oidc" as const;
  private discovery: Promise<Discovery> | undefined;
  private keys: { fetchedAt: number; keys: Jwk[] } | undefined;

  constructor(
    private readonly config: OidcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async metadata(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const response = await this.fetchImpl(`${this.config.issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new IdentityProviderError(`Discovery failed with ${response.status}`, false);
      const body = (await response.json()) as Partial<Discovery>;
      if (
        !body.authorization_endpoint ||
        !body.token_endpoint ||
        !body.jwks_uri ||
        body.issuer !== this.config.issuer
      ) {
        throw new IdentityProviderError("Discovery document is invalid", false);
      }
      return body as Discovery;
    })().catch((error: unknown) => {
      this.discovery = undefined;
      throw error instanceof IdentityProviderError ? error : new IdentityProviderError(String(error), false);
    });
    return this.discovery;
  }

  private async signingKeys(forceRefresh: boolean): Promise<Jwk[]> {
    // Ключи кэшируем на 5 минут; незнакомый kid — повод перечитать (ротация ключа).
    if (!forceRefresh && this.keys && Date.now() - this.keys.fetchedAt < 300_000) return this.keys.keys;
    const { jwks_uri } = await this.metadata();
    let response: Response;
    try {
      response = await this.fetchImpl(jwks_uri);
    } catch (error) {
      throw new IdentityProviderError(`JWKS request failed: ${String(error)}`, false);
    }
    if (!response.ok) throw new IdentityProviderError(`JWKS returned ${response.status}`, false);
    const body = (await response.json()) as { keys?: Jwk[] };
    this.keys = { fetchedAt: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
    return this.keys.keys;
  }

  private async verifySignature(token: string) {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    const header = decodePart(encodedHeader);
    if (header.alg !== "RS256" || !encodedSignature) throw new IdentityProviderError("id_token must be RS256", true);
    const pick = (keys: Jwk[]) =>
      keys.find((key) => key.kty === "RSA" && (header.kid === undefined || key.kid === header.kid));
    const jwk = pick(await this.signingKeys(false)) ?? pick(await this.signingKeys(true));
    if (!jwk) throw new IdentityProviderError("No YourSpace key for this id_token", true);
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!valid) throw new IdentityProviderError("id_token signature is invalid", true);
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const { authorization_endpoint } = await this.metadata();
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: request.redirectUri,
      scope: this.config.scopes,
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    if (request.method === "google") url.searchParams.set("yourspace_method", "google");
    if (request.requireMfa) {
      url.searchParams.set("acr_values", "mfa");
      url.searchParams.set("prompt", "login");
    }
    return url.toString();
  }

  async exchange({ code, codeVerifier, redirectUri, nonce }: CodeExchange): Promise<Identity> {
    const { token_endpoint } = await this.metadata();
    let response: Response;
    try {
      response = await this.fetchImpl(token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
          ).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
    } catch (error) {
      throw new IdentityProviderError(`Token request failed: ${String(error)}`, false);
    }
    if (response.status >= 500) throw new IdentityProviderError(`Token endpoint returned ${response.status}`, false);
    if (!response.ok) throw new IdentityProviderError("Authorization code was rejected", true);

    const tokens = (await response.json()) as { id_token?: unknown; access_token?: unknown; expires_in?: unknown };
    if (typeof tokens.id_token !== "string") throw new IdentityProviderError("id_token is missing", true);
    await this.verifySignature(tokens.id_token);
    const claims = decodePart(tokens.id_token.split(".")[1]);

    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.config.issuer) throw new IdentityProviderError("id_token issuer mismatch", true);
    if (!audience.includes(this.config.clientId)) throw new IdentityProviderError("id_token audience mismatch", true);
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
      throw new IdentityProviderError("id_token expired", true);
    }
    if (claims.nonce !== nonce) throw new IdentityProviderError("id_token nonce mismatch", true);
    if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
      throw new IdentityProviderError("id_token lacks sub or email", true);
    }

    const amr = Array.isArray(claims.amr) ? claims.amr.filter((item): item is string => typeof item === "string") : [];
    const locale = typeof claims.locale === "string" ? claims.locale.slice(0, 2) : undefined;
    const role = claims.yourspace_role;
    return {
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      name: typeof claims.name === "string" && claims.name ? claims.name : claims.email,
      locale: isLocale(locale) ? locale : undefined,
      method: amr.some((item) => FEDERATED_AMR.has(item)) ? "google" : "password",
      mfa: claims.acr === "mfa" || amr.some((item) => MFA_AMR.has(item)),
      accessToken: typeof tokens.access_token === "string" ? tokens.access_token : undefined,
      accessTokenExpiresAt:
        typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : Date.now() + 3_600_000,
      role: role === "superadmin" || role === "admin" || role === "member" ? role : undefined,
    };
  }
}
