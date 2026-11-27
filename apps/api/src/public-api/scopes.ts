import type { PublicApiScope } from "../services/public-api-keys.service.js";

/**
 * The static endpoint → scope map (PAPI-045, public API PRD §7.3, §9.2): scopes are checked per
 * endpoint from this list, never with patterns over URLs. Every registered public endpoint must be
 * listed here with the same scope, or the API refuses to start.
 */
export const PUBLIC_API_SCOPE_MAP: Record<string, PublicApiScope | "any"> = {
  "POST /people/search": "search:read",
  "GET /people/:id": "people:read",
  "POST /people/match": "people:read",
  "POST /companies/match": "companies:read",
  "GET /companies/:id": "companies:read",
  "GET /companies/:id/jobs": "jobs:read",
  "POST /contacts/email/find": "contacts:reveal",
  "POST /contacts/phone/find": "contacts:reveal",
  "POST /emails/verify": "email:verify",
  "POST /emails/verify/batch": "email:verify",
  "POST /scores": "scores:write",
  "GET /jobs/:id": "any",
  "GET /usage": "usage:read",
  "GET /webhooks": "webhooks:manage",
  "POST /webhooks": "webhooks:manage",
  "DELETE /webhooks/:id": "webhooks:manage",
};

export function scopeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** Throws when an endpoint is missing from the map or declares a different scope. */
export function assertEndpointScope(endpoint: { method: string; path: string; scope: string }, map: Record<string, string> = PUBLIC_API_SCOPE_MAP): void {
  const k = scopeKey(endpoint.method, endpoint.path);
  if (!(k in map)) throw new Error(`Public API endpoint ${k} is not in PUBLIC_API_SCOPE_MAP`);
  if (map[k] !== endpoint.scope) throw new Error(`Public API endpoint ${k} declares scope ${endpoint.scope}, the scope map says ${map[k]}`);
}
