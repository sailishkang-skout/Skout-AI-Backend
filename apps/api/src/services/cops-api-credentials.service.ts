import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * COPS-14 integration framework: apps connected to a workspace and the scoped API keys they use.
 *
 * Key format: sk_cops_<prefix>_<secret>. The prefix finds the row; only a SHA-256 of the whole key
 * is stored. A key acts for the member who made it, inside its scopes only: the auth plugin rejects
 * any route the scopes do not list, so a key can never reach admin, billing or auth routes.
 */
const { copsApps, copsApiCredentials, workspaceMembers } = schema;

export const KEY_PREFIX = "sk_cops_";

/** Each scope opens a fixed set of routes (method + path under /api/v1). */
export const API_SCOPES = {
  "accounts:read": { label: "Read accounts and Customer 360", rules: [["GET", /^\/accounts(\/|$|\?)/]] },
  "tickets:read": { label: "Read engineering tickets", rules: [["GET", /^\/tickets(\/|$|\?)/]] },
  "tickets:write": { label: "Create and update tickets", rules: [["POST", /^\/tickets(\/[0-9a-f-]{36}\/(comments|transition|escalate))?$/], ["PATCH", /^\/tickets\/[0-9a-f-]{36}$/]] },
  "incidents:read": { label: "Read incidents", rules: [["GET", /^\/incidents(\/|$|\?)/]] },
  "analytics:read": { label: "Read the analytics feed and dashboards", rules: [["GET", /^\/cops\/analytics(\/|$|\?)/]] },
} as const satisfies Record<string, { label: string; rules: ReadonlyArray<readonly [string, RegExp]> }>;
export type ApiScope = keyof typeof API_SCOPES;
export const isApiScope = (s: string): s is ApiScope => s in API_SCOPES;

export class ApiCredentialError extends Error {
  constructor(
    public code: "NOT_FOUND" | "VALIDATION_FAILED" | "BUSINESS_STATE_CONFLICT",
    message: string
  ) {
    super(message);
  }
}

export interface CredCtx {
  workspaceId: string;
  userId: string;
  requestId: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A new key: the full secret (shown once), its lookup prefix and stored hash. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const key = `${KEY_PREFIX}${prefix}_${randomBytes(24).toString("base64url")}`;
  return { key, prefix, hash: sha256(key) };
}

export function parseApiKey(token: string): { prefix: string } | null {
  const m = /^sk_cops_([0-9a-f]{12})_[A-Za-z0-9_-]{32}$/.exec(token);
  return m ? { prefix: m[1]! } : null;
}

export function keyMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when one of the scopes allows this method on this /api/v1 path. */
export function scopeAllows(scopes: readonly string[], method: string, url: string): boolean {
  const path = url.replace(/^\/api\/v1/, "").split("?")[0]!;
  return scopes.some((s) => isApiScope(s) && API_SCOPES[s].rules.some(([m, re]) => m === method.toUpperCase() && re.test(path)));
}

export interface ResolvedKey {
  credentialId: string;
  workspaceId: string;
  userId: string;
  role: string;
  scopes: string[];
}

/**
 * Finds the workspace and member a key acts for. Null when the key is unknown, revoked, expired,
 * its app is disabled, or the member who made it has left the workspace.
 */
export async function resolveApiKey(db: Db, token: string, now = new Date()): Promise<ResolvedKey | null> {
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  const [row] = await db
    .select({
      id: copsApiCredentials.id,
      workspaceId: copsApiCredentials.workspaceId,
      keyHash: copsApiCredentials.keyHash,
      scopes: copsApiCredentials.scopes,
      createdBy: copsApiCredentials.createdBy,
      expiresAt: copsApiCredentials.expiresAt,
      revokedAt: copsApiCredentials.revokedAt,
      appStatus: copsApps.status,
    })
    .from(copsApiCredentials)
    .innerJoin(copsApps, eq(copsApps.id, copsApiCredentials.appId))
    .where(eq(copsApiCredentials.prefix, parsed.prefix))
    .limit(1);
  if (!row || !keyMatches(token, row.keyHash)) return null;
  if (row.revokedAt || row.appStatus !== "active" || !row.createdBy) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, row.workspaceId), eq(workspaceMembers.userId, row.createdBy)))
    .limit(1);
  if (!member) return null;
  // Best effort; a failed timestamp write must not fail the call.
  await db.update(copsApiCredentials).set({ lastUsedAt: now }).where(eq(copsApiCredentials.id, row.id)).catch(() => undefined);
  return { credentialId: row.id, workspaceId: row.workspaceId, userId: row.createdBy, role: member.role, scopes: (row.scopes as string[]) ?? [] };
}

const audit = (db: Db, ctx: CredCtx, entityType: string, entityId: string, action: string, before: unknown, after: unknown, reason: string | null) =>
  writeCopsAudit(db, { tenantId: ctx.workspaceId, actor: { type: "user", id: ctx.userId }, entityType, entityId, action, before, after, reason, correlationId: ctx.requestId, sourceChannel: "web" });

const keyView = (k: typeof copsApiCredentials.$inferSelect) => ({
  id: k.id,
  app_id: k.appId,
  name: k.name,
  key_preview: `${KEY_PREFIX}${k.prefix}_…`,
  scopes: k.scopes,
  expires_at: k.expiresAt,
  last_used_at: k.lastUsedAt,
  revoked_at: k.revokedAt,
  created_at: k.createdAt,
});

export async function listApps(db: Db, workspaceId: string) {
  const apps = await db.select().from(copsApps).where(eq(copsApps.workspaceId, workspaceId)).orderBy(desc(copsApps.createdAt));
  const keys = await db.select().from(copsApiCredentials).where(eq(copsApiCredentials.workspaceId, workspaceId)).orderBy(desc(copsApiCredentials.createdAt));
  return apps.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    homepage_url: a.homepageUrl,
    status: a.status,
    created_at: a.createdAt,
    keys: keys.filter((k) => k.appId === a.id).map(keyView),
  }));
}

export async function createApp(db: Db, ctx: CredCtx, input: { name: string; description?: string; homepage_url?: string }) {
  const name = input.name.trim();
  const [taken] = await db.select({ id: copsApps.id }).from(copsApps).where(and(eq(copsApps.workspaceId, ctx.workspaceId), sql`lower(${copsApps.name}) = lower(${name})`)).limit(1);
  if (taken) throw new ApiCredentialError("BUSINESS_STATE_CONFLICT", "An app with this name already exists");
  return db.transaction(async (tx) => {
    const [app] = await tx
      .insert(copsApps)
      .values({ workspaceId: ctx.workspaceId, name, description: input.description ?? null, homepageUrl: input.homepage_url ?? null, createdBy: ctx.userId })
      .returning();
    await audit(tx as never, ctx, "app", app!.id, "app.created", null, { name }, null);
    return { id: app!.id, name: app!.name, status: app!.status };
  });
}

export async function setAppStatus(db: Db, ctx: CredCtx, appId: string, status: "active" | "disabled", reason: string) {
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(copsApps).where(and(eq(copsApps.id, appId), eq(copsApps.workspaceId, ctx.workspaceId))).limit(1);
    if (!app) throw new ApiCredentialError("NOT_FOUND", "App not found");
    if (app.status === status) return { id: app.id, status };
    await tx.update(copsApps).set({ status, updatedAt: new Date() }).where(eq(copsApps.id, appId));
    await audit(tx as never, ctx, "app", appId, status === "disabled" ? "app.disabled" : "app.enabled", { status: app.status }, { status }, reason.trim());
    return { id: appId, status };
  });
}

export async function createKey(db: Db, ctx: CredCtx, appId: string, input: { name: string; scopes: string[]; expires_in_days?: number }) {
  const scopes = [...new Set(input.scopes)];
  const bad = scopes.filter((s) => !isApiScope(s));
  if (scopes.length === 0 || bad.length > 0) throw new ApiCredentialError("VALIDATION_FAILED", bad.length ? `Unknown scope: ${bad.join(", ")}` : "Pick at least one scope");
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(copsApps).where(and(eq(copsApps.id, appId), eq(copsApps.workspaceId, ctx.workspaceId))).limit(1);
    if (!app) throw new ApiCredentialError("NOT_FOUND", "App not found");
    if (app.status !== "active") throw new ApiCredentialError("BUSINESS_STATE_CONFLICT", "Enable the app before adding a key");
    const { key, prefix, hash } = generateApiKey();
    const expiresAt = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000) : null;
    const [row] = await tx
      .insert(copsApiCredentials)
      .values({ workspaceId: ctx.workspaceId, appId, name: input.name.trim(), prefix, keyHash: hash, scopes, createdBy: ctx.userId, expiresAt })
      .returning();
    // The audit row carries the scopes and preview, never the key.
    await audit(tx as never, ctx, "api_credential", row!.id, "api_key.created", null, { app_id: appId, scopes, key_preview: `${KEY_PREFIX}${prefix}_…`, expires_at: expiresAt }, null);
    return { ...keyView(row!), key };
  });
}

export async function revokeKey(db: Db, ctx: CredCtx, keyId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(copsApiCredentials)
      .where(and(eq(copsApiCredentials.id, keyId), eq(copsApiCredentials.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!row) throw new ApiCredentialError("NOT_FOUND", "Key not found");
    if (row.revokedAt) return keyView(row);
    const [updated] = await tx
      .update(copsApiCredentials)
      .set({ revokedAt: new Date(), revokeReason: reason.trim() })
      .where(and(eq(copsApiCredentials.id, keyId), isNull(copsApiCredentials.revokedAt)))
      .returning();
    await audit(tx as never, ctx, "api_credential", keyId, "api_key.revoked", { revoked: false }, { revoked: true }, reason.trim());
    return keyView(updated ?? row);
  });
}
