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
 * §11.1's step-up control primitive. A caller marks a route as requiring step-up by calling this
 * before the privileged operation; it checks for an `x-reauth-at` header (an ISO timestamp) set
 * by a fresh re-authentication and rejects if it's missing or older than `withinMinutes`.
 *
 * Wave 1 scope: the enforcement primitive only. No endpoint in this codebase currently issues an
 * `x-reauth-at` value — that requires deciding whether re-authentication rides on Clerk's native
 * session-verification API or a custom short-lived-OTP step, which is a product/infra decision
 * out of scope for this pass (see docs/adr/0003-security-tenancy-step-up.md). Exported now, not
 * wired into any existing route, so nothing that currently works starts failing — wiring it in
 * is Wave 2, gated on that decision.
 */
export function assertStepUp(headers: Record<string, string | string[] | undefined>, withinMinutes = 15): void {
  const raw = headers["x-reauth-at"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw new HttpError("step_up_required", 401, { withinMinutes });
  }

  const reauthAt = new Date(value);
  if (Number.isNaN(reauthAt.getTime())) {
    throw new HttpError("step_up_required", 401, { withinMinutes, reason: "invalid x-reauth-at" });
  }

  const ageMinutes = (Date.now() - reauthAt.getTime()) / 60_000;
  if (ageMinutes < 0 || ageMinutes > withinMinutes) {
    throw new HttpError("step_up_required", 401, { withinMinutes, ageMinutes: Math.round(ageMinutes) });
  }
}

