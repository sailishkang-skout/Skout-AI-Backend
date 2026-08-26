import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { getMemberPermissions } from "./require-permission.js";

const { tenantWorkspaces, entitlements, consents } = schema;

export interface PlatformConsentSnapshot {
  subjectType: string;
  subjectId: string;
  type: string;
  basis: string;
  revokedAt: string | null;
}

/**
 * §7 Wave 2 — shared platform-plane context loaded once per authenticated request.
 * Domain services should prefer this over re-querying tenancy/entitlements/consent.
 */
export interface PlatformContext {
  tenantId: string | null;
  workspaceId: string;
  userId: string;
  permissions: string[];
  entitlements: Record<string, unknown>;
  consent: PlatformConsentSnapshot[];
}

export async function loadPlatformContext(
  db: Db,
  opts: { workspaceId: string; userId: string }
): Promise<PlatformContext> {
  const { workspaceId, userId } = opts;

  const [tenantRow] = await db
    .select({ tenantId: tenantWorkspaces.tenantId })
    .from(tenantWorkspaces)
    .where(eq(tenantWorkspaces.workspaceId, workspaceId))
    .limit(1);

  const [permissions, entitlementRows, consentRows] = await Promise.all([
    getMemberPermissions(db, workspaceId, userId),
    db.select().from(entitlements).where(eq(entitlements.workspaceId, workspaceId)),
    db
      .select({
        subjectType: consents.subjectType,
        subjectId: consents.subjectId,
        type: consents.type,
        basis: consents.basis,
        revokedAt: consents.revokedAt,
      })
      .from(consents)
      .where(eq(consents.workspaceId, workspaceId))
      .limit(200),
  ]);

  const entitlementsMap: Record<string, unknown> = {};
  for (const row of entitlementRows) {
    entitlementsMap[row.key] = row.value;
  }

  return {
    tenantId: tenantRow?.tenantId ?? null,
    workspaceId,
    userId,
    permissions,
    entitlements: entitlementsMap,
    consent: consentRows.map((c) => ({
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      type: c.type,
      basis: c.basis,
      revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    })),
  };
}
