import { CSRF_HEADER, ERROR_CODES, type ErrorCode, type Problem } from "@yourtask/contracts";

/** Ошибка API в едином формате (docs/adr/0004): интерфейс показывает текст по `code`. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | "network",
    public readonly problem?: Problem,
  ) {
    super(problem?.detail ?? problem?.title ?? code);
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" && csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network");
  }
  if (!response.ok) {
    let problem: Problem | undefined;
    try {
      problem = (await response.json()) as Problem;
    } catch {
      problem = undefined;
    }
    throw new ApiError(response.status, isErrorCode(problem?.code) ? problem.code : "internal_error", problem);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Ошибки интерфейса уходят в журнал сервера (docs/adr/0007). */
export function reportClientError(message: string, stack?: string) {
  const body = JSON.stringify({
    message: message.slice(0, 2000),
    stack: stack?.slice(0, 8000),
    url: location.pathname,
    client: "web",
  });
  try {
    if (navigator.sendBeacon?.("/api/v1/client-errors", new Blob([body], { type: "application/json" }))) return;
  } catch {
    // ниже — запасной путь
  }
  void fetch("/api/v1/client-errors", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
    keepalive: true,
  }).catch(() => undefined);
}

export function installClientErrorReporting() {
  window.addEventListener("error", (event) =>
    reportClientError(event.message, (event.error as Error | undefined)?.stack),
  );
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as unknown;
    if (reason instanceof ApiError) return; // ошибки API уже записаны сервером
    reportClientError(
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : undefined,
    );
  });
}
