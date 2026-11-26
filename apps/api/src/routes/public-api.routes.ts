import type { FastifyReply } from "fastify";

/** Path prefix of the customer-facing public API (PRD D1). Served on www.skoutai.io via the edge rule in PAPI-001. */
export const PUBLIC_API_PREFIX = "/api/public/v1";

export function isPublicApiPath(url: string): boolean {
  return url === "/api/public" || url.startsWith("/api/public/") || url.startsWith("/api/public?");
}

/** Headers every public API response carries (PRD §9.5). */
export function setPublicApiSecurityHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.header("strict-transport-security", "max-age=63072000; includeSubDomains");
}
