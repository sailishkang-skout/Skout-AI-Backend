import type { FastifyInstance, FastifyReply } from "fastify";

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

export async function publicApiRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_request, reply, payload) => {
    setPublicApiSecurityHeaders(reply);
    // The public API never sets cookies, whatever an upstream hook may have added.
    reply.removeHeader("set-cookie");
    return payload;
  });

  // Unauthenticated liveness check, used to prove the www edge reaches the API and not the website.
  app.get("/health", async () => ({ status: "ok", service: "skout-public-api", version: "v1" }));
}
