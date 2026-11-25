/**
 * Public API error shape (public API PRD CONV-6): every error is
 * { "error": { "type", "code", "message", "request_id", "doc_url" } }.
 */
export const PUBLIC_API_ERROR_CODES = {
  authentication_failed: { status: 401, type: "authentication_error" },
  key_revoked: { status: 401, type: "authentication_error" },
  key_expired: { status: 401, type: "authentication_error" },
  ip_not_allowed: { status: 403, type: "permission_error" },
  scope_missing: { status: 403, type: "permission_error" },
  addon_disabled: { status: 403, type: "permission_error" },
  live_access_not_enabled: { status: 403, type: "permission_error" },
  workspace_suspended: { status: 403, type: "permission_error" },
  insufficient_credits: { status: 402, type: "billing_error" },
  cap_reached: { status: 429, type: "rate_limit_error" },
  quota_reached: { status: 429, type: "rate_limit_error" },
  rate_limited: { status: 429, type: "rate_limit_error" },
  invalid_request: { status: 422, type: "invalid_request_error" },
  idempotency_conflict: { status: 409, type: "invalid_request_error" },
  not_found: { status: 404, type: "invalid_request_error" },
  upstream_unavailable: { status: 503, type: "api_error" },
  internal_error: { status: 500, type: "api_error" },
} as const;

export type PublicApiErrorCode = keyof typeof PUBLIC_API_ERROR_CODES;

export const PUBLIC_API_DOCS_ERRORS_URL = "https://www.skoutai.io/docs/api/errors";

export interface PublicApiErrorBody {
  error: { type: string; code: PublicApiErrorCode; message: string; request_id: string; doc_url: string };
}

export function publicApiError(code: PublicApiErrorCode, message: string, requestId: string): { status: number; body: PublicApiErrorBody } {
  const def = PUBLIC_API_ERROR_CODES[code];
  return {
    status: def.status,
    body: { error: { type: def.type, code, message, request_id: requestId, doc_url: `${PUBLIC_API_DOCS_ERRORS_URL}#${code}` } },
  };
}
