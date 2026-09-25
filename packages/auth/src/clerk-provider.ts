import type { AuthProvider, AuthVerifyContext, VerifiedIdentity } from "./auth-provider.js";
import { createLogger } from "@skout/observability";
import { AuthTokenExpiredError, AuthTokenInvalidError } from "./auth-token.js";

const log = createLogger("auth.clerk");

function readEmailVerified(claims: Record<string, unknown>): boolean {
  if (typeof claims.email_verified === "boolean") return claims.email_verified;
  if (claims.email_verified === "true") return true;
  if (claims.email_verified === "false") return false;
  return typeof claims.email === "string" && claims.email.length > 0;
}

function readEmail(claims: Record<string, unknown>): string | undefined {
  const email = claims.email;
  return typeof email === "string" && email.length > 0 ? email : undefined;
}

function readName(claims: Record<string, unknown>, email?: string): string | undefined {
  const name = claims.name ?? claims.first_name;
  if (typeof name === "string" && name.length > 0) return name;
  return email;
}

/** AUTH-BE-03 — only place in the monorepo that imports `@clerk/backend` for JWT verification. */
export class ClerkAuthProvider implements AuthProvider {
  readonly id = "clerk";

  async verify(token: string, ctx: AuthVerifyContext): Promise<VerifiedIdentity> {
    const { verifyToken } = await import("@clerk/backend");
    try {
      const claims = (await verifyToken(token, {
        secretKey: ctx.clerkSecretKey,
        authorizedParties: ctx.authorizedParties,
      })) as Record<string, unknown> | null;

      const subject = claims?.sub;
      if (typeof subject !== "string" || !subject) {
        throw new AuthTokenInvalidError();
      }

      const emailVerified = readEmailVerified(claims ?? {});
      const email = readEmail(claims ?? {});

      return {
        provider: "clerk",
        subject,
        email,
        emailVerified,
        name: readName(claims ?? {}, email),
      };
    } catch (err) {
      if (err instanceof AuthTokenInvalidError) throw err;
      const message = err instanceof Error ? err.message : "";
      // Clerk's `reason` is a fixed enum (e.g. token-invalid-authorized-parties, jwk-kid-mismatch) —
      // safe to log, unlike the message which can echo claim values. Never log the token.
      const reason = (err as { reason?: unknown } | null)?.reason;
      log.warn("clerk.verify_failed", {
        reason: typeof reason === "string" ? reason : "unknown",
        errorName: err instanceof Error ? err.name : typeof err,
      });
      if (/expired/i.test(message)) {
        throw new AuthTokenExpiredError(message);
      }
      throw new AuthTokenInvalidError();
    }
  }
}

export const clerkAuthProvider = new ClerkAuthProvider();
