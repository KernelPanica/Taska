import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode, Problem, ProblemFieldError } from "@yourtask/contracts";

const TITLES: Record<ErrorCode, string> = {
  bad_request: "Bad request",
  validation_failed: "Validation failed",
  unauthenticated: "Authentication required",
  csrf_invalid: "Invalid CSRF token",
  forbidden: "Forbidden",
  mfa_required: "Second factor required",
  not_found: "Not found",
  conflict: "Conflict",
  rate_limited: "Too many requests",
  login_failed: "Sign-in failed",
  login_expired: "Sign-in expired",
  account_conflict: "Account conflict",
  account_deactivated: "Account deactivated",
  version_conflict: "Someone else changed this first",
  transition_blocked: "Status change is blocked",
  status_choice_required: "Choose a status",
  ticket_title_only: "Only the title is open to you",
  hierarchy_cycle: "That would make a cycle in the tree",
  subordination_violation: "The type rules forbid this parent",
  view_as_read_only: "Look-only mode",
  link_exists: "These tickets are already linked",
  integration_unavailable: "An external service did not answer",
  upload_refused: "The file cannot be attached",
  file_type_mismatch: "The file is not what its extension says",
  children_choice_required: "Choose what happens to the children",
  bulk_confirm_required: "Confirm deleting several tickets",
  ticket_in_trash: "The ticket is in the trash",
  ticket_purged: "The ticket was deleted for good",
  tql_invalid: "The query has an error",
  zone_not_for_type: "This type has no status in the zone",
  catalog_unavailable: "YourSpace catalog is unavailable",
  identity_provider_error: "YourSpace is unavailable",
  internal_error: "Internal server error",
};

/** Ошибка предметной области; обработчик превращает её в Problem Details. */
export class AppError extends Error {
  override name = "AppError";
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    detail?: string,
    public readonly errors?: ProblemFieldError[],
    /** Дополнительные члены Problem Details (RFC 9457 разрешает расширения): актуальное состояние, варианты. */
    public readonly extensions?: Record<string, unknown>,
  ) {
    super(detail ?? TITLES[code]);
  }
}

export function problem(
  request: FastifyRequest,
  status: number,
  code: ErrorCode,
  detail?: string,
  errors?: ProblemFieldError[],
  extensions?: Record<string, unknown>,
): Problem {
  return {
    ...extensions,
    type: `https://yourtask.dev/errors/${code}`,
    title: TITLES[code],
    status,
    code,
    ...(detail ? { detail } : {}),
    instance: request.url.split("?")[0] ?? request.url,
    requestId: request.id,
    ...(errors?.length ? { errors } : {}),
  };
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  detail?: string,
  errors?: ProblemFieldError[],
  extensions?: Record<string, unknown>,
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(problem(request, status, code, detail, errors, extensions));
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal_error";
  return "bad_request";
}

/** JSON-схема Problem для OpenAPI. */
export const problemSchema = {
  $id: "Problem",
  type: "object",
  description: "RFC 9457 Problem Details with a machine-readable `code` (docs/adr/0004).",
  required: ["type", "title", "status", "code", "requestId"],
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    code: { type: "string", enum: Object.keys(TITLES) },
    detail: { type: "string" },
    instance: { type: "string" },
    requestId: { type: "string" },
    errors: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "message"],
        properties: { field: { type: "string" }, message: { type: "string" } },
      },
    },
  },
} as const;

export const problemResponses = {
  "4xx": { $ref: "Problem#" },
  "5xx": { $ref: "Problem#" },
} as const;

/** Подключает единый формат ошибок и журналирование ошибок ко всему приложению. */
export function registerErrorHandling(app: FastifyInstance) {
  app.addSchema(problemSchema);

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      request.log.info({ code: error.code, status: error.status }, error.message);
      return sendProblem(request, reply, error.status, error.code, error.message, error.errors, error.extensions);
    }

    if (error.validation) {
      const errors = error.validation.map((item) => ({
        field:
          (item.instancePath || `/${String((item.params as { missingProperty?: string }).missingProperty ?? "")}`)
            .replace(/^\//, "")
            .replaceAll("/", ".") ||
          (error.validationContext ?? "body"),
        message: item.message ?? "is invalid",
      }));
      return sendProblem(request, reply, 400, "validation_failed", error.message, errors);
    }

    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "Unhandled error");
      return sendProblem(request, reply, 500, "internal_error");
    }
    return sendProblem(request, reply, status, codeForStatus(status), error.message);
  });
}
