import { and, eq, like } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { defaultFeatures, isOptInFeature, type ProductFeature, type WorkspaceAccessStatus } from "@skout/shared";

/**
 * Early access state of a workspace (spec 2026-11-17): its access status and the on/off map of the
 * product feature switches. A switch is the platform-managed entitlement `feature.<key>`; only an
 * explicit `false` turns it off, so workspaces that predate the switches keep everything. Opt-in
 * features (WORKBOOKS_V2) are the reverse: only an explicit `true` turns them on.
 *
 * Cached per process for 30s: the guard runs on every request. COPS writes call
 * invalidateWorkspaceAccess, so the process that made the change sees it at once and the others
 * within the TTL.
 */
export interface WorkspaceAccessState {
  status: WorkspaceAccessStatus;
  features: Record<ProductFeature, boolean>;
}

export const WORKSPACE_ACCESS_TTL_MS = 30_000;
const FEATURE_PREFIX = "feature.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cache = new Map<string, { value: WorkspaceAccessState; expires: number }>();

export async function loadWorkspaceAccess(db: Db, workspaceId: string): Promise<WorkspaceAccessState> {
  // Pseudo-workspaces (e.g. the external email-intel caller) are not tenants: nothing to gate, and
  // they never hold an opt-in feature.
  if (!UUID.test(workspaceId)) return { status: "active", features: defaultFeatures() };
  const hit = cache.get(workspaceId);
  if (hit && hit.expires > Date.now()) return hit.value;

  const [ws] = await db
    .select({ status: schema.workspaces.accessStatus })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const rows = await db
    .select({ key: schema.entitlements.key, value: schema.entitlements.value })
    .from(schema.entitlements)
    .where(and(eq(schema.entitlements.workspaceId, workspaceId), like(schema.entitlements.key, `${FEATURE_PREFIX}%`)));

  const features = defaultFeatures();
  for (const row of rows) {
    const key = row.key.slice(FEATURE_PREFIX.length) as ProductFeature;
    if (!(key in features)) continue;
    // Opt-in features are on only for an explicit `true`; everything else is off only for an explicit `false`.
    if (isOptInFeature(key)) features[key] = row.value === true;
    else if (row.value === false) features[key] = false;
  }
  const value: WorkspaceAccessState = { status: ws?.status ?? "active", features };
  cache.set(workspaceId, { value, expires: Date.now() + WORKSPACE_ACCESS_TTL_MS });
  return value;
}

export function invalidateWorkspaceAccess(workspaceId: string): void {
  cache.delete(workspaceId);
}
