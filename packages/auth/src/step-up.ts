import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "./http.js";

const { auditLogs } = schema;

/**
 * §11.1 Security and tenancy — "complete audit events for every privileged action." Reuses the
 * existing audit_logs table (packages/db/src/schema/audit.ts, already used by apps/crm's
 * AuditService for entity CRUD) rather than introducing a parallel audit table — same principle
 * as §1's "does this feature read/write the canonical entities, or does it fork state" check.
 *
 * `action` is free text (e.g. "identity_merge.resolve", "workspace_member_role.grant") rather
 * than apps/crm's closed AuditAction union, since privileged actions span services and aren't
 * limited to CRUD verbs.
 */
export interface PrivilegedActionInput {
  workspaceId: string;
  actorId: string | undefined;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
}

type AuditDb = Pick<Db, "insert">;

export async function recordPrivilegedAction(db: AuditDb, input: PrivilegedActionInput): Promise<void> {
  await db.insert(auditLogs).values({
    workspaceId: input.workspaceId,
    actorId: input.actorId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeState: (input.beforeState as Record<string, unknown> | null) ?? null,
    afterState: (input.afterState as Record<string, unknown> | null) ?? null,
  });
}

/**
 * §11.1 — issues a short-lived, server-signed proof of fresh re-authentication. Format:
 * "<userId>.<issuedAtMs>.<hmacHex>", hmacHex = HMAC-SHA256(secret, "<userId>.<issuedAtMs>").
 *
 * Task 16 fix: the original Wave-1 assertStepUp() below only checked an unsigned client-supplied
 * `x-reauth-at` timestamp — any caller could set that header to "now" and pass, which would have
 * made step-up a no-op the moment anything actually enforced it. Signing closes that gap. See
 * apps/api/src/routes/step-up.routes.ts for the real issuer (verifies a fresh Clerk token before
 * calling this).
 */
export function issueStepUpToken(secret: string, userId: string, issuedAtMs: number = Date.now()): string {
  const payload = `${userId}.${issuedAtMs}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/**
 * §11.1's step-up control primitive. A caller marks a route as requiring step-up by calling this
 * before the privileged operation; it verifies the `x-reauth-token` header (issueStepUpToken's
 * output) — signature, matching userId, and freshness within `withinMinutes` — and throws 401
 * unless all three hold.
 *
 * `secret` must be the same value the issuing endpoint used (config.STEP_UP_SIGNING_SECRET).
 * `expectedUserId` must be the caller's own authenticated userId (request.userId) — this is what
 * stops one user's step-up token from being replayed to step up a different user's session.
 */
export function assertStepUp(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  expectedUserId: string,
  withinMinutes = 15
): void {
  const raw = headers["x-reauth-token"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw new HttpError("step_up_required", 401, { withinMinutes });
  }

  const parts = value.split(".");
  if (parts.length !== 3) {
    throw new HttpError("step_up_required", 401, { withinMinutes, reason: "malformed x-reauth-token" });
  }
  const [tokenUserId, issuedAtStr, providedHmac] = parts as [string, string, string];
  const issuedAtMs = Number(issuedAtStr);
  if (!tokenUserId || !Number.isFinite(issuedAtMs)) {
    throw new HttpError("step_up_required", 401, { withinMinutes, reason: "malformed x-reauth-token" });
  }

  const expectedHmac = createHmac("sha256", secret).update(`${tokenUserId}.${issuedAtMs}`).digest("hex");
  const providedBuf = Buffer.from(providedHmac, "hex");
  const expectedBuf = Buffer.from(expectedHmac, "hex");
  const signatureValid = providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
  if (!signatureValid) {
    throw new HttpError("step_up_required", 401, { withinMinutes, reason: "invalid signature" });
  }

  if (tokenUserId !== expectedUserId) {
    throw new HttpError("step_up_required", 401, { withinMinutes, reason: "token does not match caller" });
  }

  const ageMinutes = (Date.now() - issuedAtMs) / 60_000;
  if (ageMinutes < 0 || ageMinutes > withinMinutes) {
    throw new HttpError("step_up_required", 401, { withinMinutes, ageMinutes: Math.round(ageMinutes) });
  }
}

