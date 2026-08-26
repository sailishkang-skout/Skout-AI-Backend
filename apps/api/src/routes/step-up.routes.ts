import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveOrProvisionUser, issueStepUpToken } from "@skout/auth";
import { errorResponse } from "../utils/http.js";
import { computeAuthorizedParties } from "../plugins/auth.js";

const bodySchema = z.object({
  /**
   * A fresh Clerk session/JWT — the frontend re-prompts the user (password/MFA, per Clerk's own
   * re-authentication UI) and posts the resulting token here. This is deliberately re-verified
   * independently of the long-lived session already on this request, since the whole point of
   * step-up is proving the user *just* re-authenticated, not that they're still logged in.
   */
  clerkToken: z.string().min(1),
});

/**
 * §11.1 (Enterprise Completion Plan) — Task 16: the real issuer for @skout/auth's
 * assertStepUp() control, using the same Clerk verifyToken pattern apps/api's auth plugin
 * (plugins/auth.ts) already uses for the primary session. Independently verifies the posted
 * Clerk token, confirms it resolves to the *same* internal user already authenticated on this
 * request (not just any valid Clerk token — see the userId match check below, which is what
 * stops a stolen-but-valid Clerk token for a different account from stepping up this session),
 * then issues a signed, short-lived x-reauth-token (packages/auth/src/step-up.ts).
 *
 * Deliberately refuses when Clerk isn't the active auth mode (AUTH_STUB / no CLERK_SECRET_KEY)
 * or when STEP_UP_SIGNING_SECRET isn't configured — step-up has no meaning without a real
 * interactive re-auth step behind it, so this fails closed (503/501) rather than issuing a
 * token that doesn't actually prove anything.
 */
export async function stepUpRoutes(app: FastifyInstance) {
  app.post("/auth/step-up", async (request, reply) => {
    if (!request.userId) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const config = app.config;
    if (!config.STEP_UP_SIGNING_SECRET) {
      return reply.code(503).send(errorResponse("Step-up re-authentication is not configured", 503));
    }
    const clerkKeyInvalid =
      !config.CLERK_SECRET_KEY || config.CLERK_SECRET_KEY.trim().toLowerCase() === "replace-me";
    if (config.AUTH_STUB || clerkKeyInvalid) {
      return reply
        .code(501)
        .send(errorResponse("Step-up re-authentication requires Clerk auth to be active", 501));
    }

    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid step-up payload", 400, parsed.error.flatten()));
    }

    let clerkUserId: string;
    let email: string;
    let fullName: string;
    try {
      const { verifyToken } = await import("@clerk/backend");
      const claims = await verifyToken(parsed.data.clerkToken, {
        secretKey: config.CLERK_SECRET_KEY,
        authorizedParties: computeAuthorizedParties(config),
      });
      if (!claims?.sub) {
        return reply.code(401).send(errorResponse("Invalid Clerk token", 401));
      }
      clerkUserId = claims.sub;
      email = String(claims.email ?? `${clerkUserId}@clerk.local`);
      fullName = String(claims.name ?? claims.first_name ?? email);
    } catch (err) {
      app.log.warn({ err }, "Step-up Clerk token verification failed");
      return reply.code(401).send(errorResponse("Invalid or expired Clerk token", 401));
    }

    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const result = await resolveOrProvisionUser(app.db, clerkUserId, email, fullName);
    if (result.userId !== request.userId) {
      return reply
        .code(403)
        .send(errorResponse("Re-authentication does not match the current session", 403));
    }

    const issuedAtMs = Date.now();
    const reauthToken = issueStepUpToken(config.STEP_UP_SIGNING_SECRET, result.userId, issuedAtMs);
    return reply.send({
      data: {
        reauthToken,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresInMinutes: 15,
      },
    });
  });
}
