import type { FastifyInstance } from "fastify";
import { getPublicJwks } from "../services/token.service.js";

/**
 * AUTH-BE-12 — public JWKS endpoint, per §3 of the ticket doc: `GET /.well-known/jwks.json`,
 * kid-addressed public keys only. Registered at the true root path (not under /api/v1) to match
 * the standard `.well-known` convention other JWT consumers expect. Public: no auth required,
 * and it can never leak a private key (getPublicJwks only ever reads AUTH_JWT_PUBLIC_KEY_SET).
 */
export async function jwksRoutes(app: FastifyInstance) {
  app.get("/.well-known/jwks.json", async (request, reply) => {
    if (!app.config.AUTH_JWT_PUBLIC_KEY_SET) {
      return reply.status(503).send({ error: "own_auth_not_configured" });
    }
    // Public keys change only on rotation (rare); a short cache is a safe, standard default.
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send(getPublicJwks(app.config));
  });
}
