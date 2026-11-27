import type { Locale, LoginMethod } from "@yourtask/contracts";

/**
 * Граница между YourTask и YourSpace (R-2.1, YS-01, docs/adr/0003).
 *
 * YourSpace — провайдер OpenID Connect (authorization code + PKCE), протокол описан в
 * `docs/connect-a-product.md` репозитория YourSpace. Реализации: встроенная заглушка для разработки
 * и тестов (dev-yourspace.ts) и OIDC-адаптер (oidc-provider.ts).
 */
export interface Identity {
  /** Неизменяемый идентификатор аккаунта YourSpace. */
  subject: string;
  email: string;
  name: string;
  locale?: Locale | undefined;
  /** Чем человек вошёл в YourSpace: логин и пароль или привязанный Google. */
  method: LoginMethod;
  /** YourSpace подтвердил вторую проверку входа. */
  mfa: boolean;
  /** Общая роль YourSpace (`yourspace_role`): суперадмин YourSpace — суперадмин и в YourTask. */
  role?: "superadmin" | "admin" | "member" | undefined;
  /** Токен доступа YourSpace: им YourTask обращается к YourWiki от имени человека (WK-02). */
  accessToken?: string | undefined;
  accessTokenExpiresAt?: number | undefined;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  method: LoginMethod;
  /** Потребовать у YourSpace вторую проверку (step-up для администраторов). */
  requireMfa: boolean;
}

export interface CodeExchange {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
}

export class IdentityProviderError extends Error {
  override name = "IdentityProviderError";
  constructor(
    message: string,
    /** true — отказ по вине пользователя/кода (истёк, подделан); false — YourSpace недоступен. */
    public readonly rejected: boolean,
  ) {
    super(message);
  }
}

export interface IdentityProvider {
  readonly kind: "dev" | "oidc";
  /** Адрес, куда отправить браузер для входа в YourSpace. */
  authorizationUrl(request: AuthorizationRequest): Promise<string>;
  /** Меняет одноразовый код на подтверждённую личность. */
  exchange(exchange: CodeExchange): Promise<Identity>;
}
