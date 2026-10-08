/** Shared COPS error and correlation helpers. */
import { randomUUID } from "node:crypto";

export interface CopsErrorBody {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  request_id: string;
  retryable: boolean;
}

export function copsErrorBody(input: {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}): CopsErrorBody {
  return {
    code: input.code,
    message: input.message,
    details: input.details ?? null,
    request_id: input.requestId,
    retryable: input.retryable ?? false,
  };
}

export function copsErrorStatus(code: string): number {
  switch (code) {
    case "VALIDATION_FAILED":
    case "IDEMPOTENCY_KEY_REUSED":
      return 422;
    case "BUSINESS_STATE_CONFLICT":
      return 409;
    case "FORBIDDEN":
      return 403;
    case "RATE_LIMITED":
      return 429;
    case "NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}

/** Use a valid incoming request UUID for correlation, otherwise create a new trace id. */
export function resolveCorrelationId(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw)) {
    return raw.toLowerCase();
  }
  return randomUUID();
}
