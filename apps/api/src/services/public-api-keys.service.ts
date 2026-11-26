import { isIP } from "node:net";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { digestsEqual, hmacSha256Hex, newKeyPrefix, newKeySecret } from "../lib/api-key-crypto.js";
import { HttpError } from "../utils/http.js";
import { liveKeyBlock } from "./public-api-addon.service.js";
import { notifyPublicKeyChange, type CachedKey } from "../lib/public-key-cache.js";

const { apiKeys, workspaceApiSettings, auditLogs, users } = schema;

/**
 * Public API keys (PAPI-021, public API PRD KEY-1 to KEY-10, D8).
 *
 * Format: sk_live_<prefix>_<secret> / sk_test_<prefix>_<secret>; prefix = 12 hex chars, secret =
 * 32 random bytes as base64url (43 chars). Only HMAC-SHA256(key, API_KEY_PEPPER) is stored; the full
 * key is returned once, at creation or rotation. Every key expires within 90 days.
 */
export type ApiKeyType = "live" | "test";

export const PUBLIC_API_SCOPES = [
  "search:read",
  "people:read",
  "companies:read",
  "contacts:reveal",
  "email:verify",
  "jobs:read",
  "scores:write",
  "usage:read",
  "webhooks:manage",
] as const;
export type PublicApiScope = (typeof PUBLIC_API_SCOPES)[number];

export const MAX_KEY_LIFETIME_DAYS = 90;
/** Rotation grace periods the owner can pick (KEY-7): none, 24 hours or 7 days. */
export const ROTATION_GRACE_HOURS = [0, 24, 168] as const;

const SECRET_BYTES = 32;
const KEY_RE = /^sk_(live|test)_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const DAY_MS = 86_400_000;

export interface KeyServiceConfig {
  /** API_KEY_PEPPER; required to create or verify keys. */
  pepper: string | undefined;
  /** Default active-key limit (PUBLIC_API_MAX_ACTIVE_KEYS); CustomerOps can override per workspace. */
  maxActiveKeys: number;
  /** Cached prefix lookup (PAPI-023); without it every verify reads the database. */
  lookup?: (prefix: string) => Promise<CachedKey | null>;
}

export interface KeyActor {
  workspaceId: string;
  userId: string;
}

function requirePepper(cfg: KeyServiceConfig): string {
  if (!cfg.pepper) throw new HttpError("The public API is not configured (API_KEY_PEPPER missing)", 503);
  return cfg.pepper;
}

/** Splits a token into type and prefix, or null when it isn't a well-formed public key (KEY-1). */
export function parsePublicApiKey(token: string): { type: ApiKeyType; prefix: string } | null {
  const m = KEY_RE.exec(token);
  return m ? { type: m[1] as ApiKeyType, prefix: m[2]! } : null;
}

export function generatePublicApiKey(type: ApiKeyType, pepper: string): { key: string; prefix: string; hmac: string } {
  const prefix = newKeyPrefix();
  const key = `sk_${type}_${prefix}_${newKeySecret(SECRET_BYTES)}`;
  return { key, prefix, hmac: hmacSha256Hex(key, pepper) };
}

export function maskKey(type: string, prefix: string): string {
  return `sk_${type}_${prefix}_••••`;
}

export type KeyStatus = "active" | "grace" | "expired" | "revoked";

export function keyStatus(row: typeof apiKeys.$inferSelect, now = new Date()): KeyStatus {
  if (row.revokedAt && row.revokedAt <= now) return "revoked";
  if (row.expiresAt <= now) return "expired";
  if (row.graceUntil) return row.graceUntil <= now ? "revoked" : "grace";
  return "active";
}

export interface ApiKeyView {
  id: string;
  name: string;
  type: ApiKeyType;
  masked_key: string;
  scopes: string[];
  ip_allowlist: string[];
  daily_credit_cap: number | null;
  monthly_credit_cap: number | null;
  status: KeyStatus;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  grace_until: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  replaced_by: string | null;
}

export function keyView(row: typeof apiKeys.$inferSelect, now = new Date()): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ApiKeyType,
    masked_key: maskKey(row.type, row.prefix),
    scopes: row.scopes,
    ip_allowlist: row.ipAllowlist,
    daily_credit_cap: row.dailyCreditCap,
    monthly_credit_cap: row.monthlyCreditCap,
    status: keyStatus(row, now),
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    grace_until: row.graceUntil?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    last_used_ip: row.lastUsedIp,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    revoke_reason: row.revokeReason,
    replaced_by: row.replacedBy,
  };
}

// --- Verification ------------------------------------------------------------

export type VerifyFailure = "authentication_failed" | "key_revoked" | "key_expired";
export type VerifyResult =
  | { ok: true; key: typeof apiKeys.$inferSelect; /** Known when the lookup came through the key cache. */ addonEnabled?: boolean }
  | { ok: false; error: VerifyFailure };

/** A fixed digest compared against when the prefix is unknown, so both failures take the same time. */
const DUMMY_DIGEST = "0".repeat(64);

/**
 * Checks a bearer token (PRD §9.1): prefix lookup, then a constant-time HMAC compare. A malformed
 * token, an unknown prefix and a wrong secret all return the same `authentication_failed`.
 * Revoked/expired are only reported once the secret matched. A rotated key works until its
 * grace period ends.
 */
export async function verifyPublicApiKey(db: Db, cfg: KeyServiceConfig, token: string, now = new Date()): Promise<VerifyResult> {
  const pepper = requirePepper(cfg);
  const parsed = parsePublicApiKey(token);
  let row: typeof apiKeys.$inferSelect | undefined;
  let addonEnabled: boolean | undefined;
  if (parsed && cfg.lookup) {
    const cached = await cfg.lookup(parsed.prefix);
    row = cached?.key;
    addonEnabled = cached?.addonEnabled;
  } else if (parsed) {
    [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, parsed.prefix)).limit(1);
  }
  const digest = hmacSha256Hex(token, pepper);
  const matches = digestsEqual(digest, row?.keyHmac ?? DUMMY_DIGEST);
  if (!row || !parsed || !matches || row.type !== parsed.type) return { ok: false, error: "authentication_failed" };
  const status = keyStatus(row, now);
  if (status === "revoked") return { ok: false, error: "key_revoked" };
  if (status === "expired") return { ok: false, error: "key_expired" };
  return addonEnabled === undefined ? { ok: true, key: row } : { ok: true, key: row, addonEnabled };
}

// --- Create / list / rotate / revoke -----------------------------------------

export interface CreateKeyInput {
  name: string;
  type: ApiKeyType;
  scopes: string[];
  ipAllowlist?: string[];
  /** 1..90; defaults to 90 (KEY-5). */
  expiresInDays?: number;
  dailyCreditCap?: number | null;
  monthlyCreditCap?: number | null;
}

function validateScopes(scopes: string[]): PublicApiScope[] {
  const unique = [...new Set(scopes)];
  const bad = unique.filter((s) => !(PUBLIC_API_SCOPES as readonly string[]).includes(s));
  if (unique.length === 0) throw new HttpError("Pick at least one scope", 422);
  if (bad.length > 0) throw new HttpError(`Unknown scope: ${bad.join(", ")}`, 422);
  return unique as PublicApiScope[];
}

/** Each entry is an IPv4/IPv6 address or CIDR block. */
function validateIpAllowlist(list: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const entry = raw.trim();
    const [addr, bits, extra] = entry.split("/");
    const family = isIP(addr ?? "");
    const max = family === 4 ? 32 : 128;
    const bitsOk = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max);
    if (!family || !bitsOk || extra !== undefined) throw new HttpError(`Not a valid IP address or CIDR block: ${raw}`, 422);
    out.push(entry);
  }
  if (out.length > 50) throw new HttpError("An IP allowlist can hold at most 50 entries", 422);
  return [...new Set(out)];
}

function validateExpiryDays(days: number | undefined): number {
  const d = days ?? MAX_KEY_LIFETIME_DAYS;
  if (!Number.isInteger(d) || d < 1 || d > MAX_KEY_LIFETIME_DAYS) {
    throw new HttpError(`Keys expire after 1 to ${MAX_KEY_LIFETIME_DAYS} days`, 422);
  }
  return d;
}

function validateCap(v: number | null | undefined, label: string): number | null {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0) throw new HttpError(`${label} must be a whole number of credits, 0 or more`, 422);
  return v;
}

async function maxActiveKeysFor(db: Db, cfg: KeyServiceConfig, workspaceId: string): Promise<number> {
  const [s] = await db
    .select({ max: workspaceApiSettings.maxActiveKeys })
    .from(workspaceApiSettings)
    .where(eq(workspaceApiSettings.workspaceId, workspaceId))
    .limit(1);
  return s?.max ?? cfg.maxActiveKeys;
}

/** Keys that still work: not revoked, not expired, not past their rotation grace period. */
function activeKeysWhere(workspaceId: string, now: Date) {
  return and(
    eq(apiKeys.workspaceId, workspaceId),
    isNull(apiKeys.revokedAt),
    gt(apiKeys.expiresAt, now),
    sql`(${apiKeys.graceUntil} is null or ${apiKeys.graceUntil} > ${now.toISOString()}::timestamptz)`
  );
}

/** Serialises key creation per workspace so two requests can't both pass the active-key limit. */
async function lockWorkspaceKeys(tx: Db, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"api_keys:" + workspaceId}))`);
}

async function assertCanCreate(db: Db, workspaceId: string, type: ApiKeyType, userId: string) {
  const block = await liveKeyBlock(db, workspaceId);
  if (block === "addon_disabled") throw new HttpError("addon_disabled", 403, { message: "Enable the API add-on first." });
  if (type === "live" && block === "workspace_suspended") {
    throw new HttpError("workspace_suspended", 403, { message: "Settle the workspace's subscription to create live keys." });
  }
  if (type === "live" && block === "live_access_not_enabled") {
    throw new HttpError("live_access_not_enabled", 403, {
      message: "Trial and early-access workspaces can create test keys only until they buy credits.",
    });
  }
  // ADD-3: live keys need an active user (verified email). Test keys don't.
  if (type === "live" && !(await isActiveUser(db, userId))) {
    throw new HttpError("user_not_active", 403, { message: "Verify your email address to create live keys. Test keys work meanwhile." });
  }
}

async function isActiveUser(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.isActive === true;
}

async function auditKey(
  tx: Db,
  actor: KeyActor,
  keyId: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason?: string
) {
  await tx.insert(auditLogs).values({
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action,
    entityType: "api_key",
    entityId: keyId,
    beforeState: before,
    afterState: after,
    reason: reason ?? null,
  });
}

/** Creates a key and returns it in full, once (KEY-3). */
export async function createPublicApiKey(
  db: Db,
  cfg: KeyServiceConfig,
  actor: KeyActor,
  input: CreateKeyInput,
  now = new Date()
): Promise<ApiKeyView & { key: string }> {
  const pepper = requirePepper(cfg);
  const name = input.name?.trim();
  if (!name || name.length > 100) throw new HttpError("Give the key a name (up to 100 characters)", 422);
  if (input.type !== "live" && input.type !== "test") throw new HttpError("Key type must be live or test", 422);
  const scopes = validateScopes(input.scopes ?? []);
  const ipAllowlist = validateIpAllowlist(input.ipAllowlist);
  const days = validateExpiryDays(input.expiresInDays);
  const dailyCreditCap = validateCap(input.dailyCreditCap, "Daily credit cap");
  const monthlyCreditCap = validateCap(input.monthlyCreditCap, "Monthly credit cap");
  await assertCanCreate(db, actor.workspaceId, input.type, actor.userId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockWorkspaceKeys(tx, actor.workspaceId);
    const max = await maxActiveKeysFor(tx, cfg, actor.workspaceId);
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(apiKeys).where(activeKeysWhere(actor.workspaceId, now))) as [
      { n: number },
    ];
    if (n >= max) throw new HttpError("key_limit_reached", 409, { message: `A workspace can have at most ${max} active keys.`, limit: max });
    const { key, prefix, hmac } = generatePublicApiKey(input.type, pepper);
    const [row] = await tx
      .insert(apiKeys)
      .values({
        workspaceId: actor.workspaceId,
        createdBy: actor.userId,
        name,
        type: input.type,
        prefix,
        keyHmac: hmac,
        scopes,
        ipAllowlist,
        dailyCreditCap,
        monthlyCreditCap,
        expiresAt: new Date(now.getTime() + days * DAY_MS),
        createdAt: now,
      })
      .returning();
    // The audit row carries the masked key and settings, never the key itself.
    await auditKey(tx, actor, row!.id, "api_key.created", null, {
      masked_key: maskKey(row!.type, row!.prefix),
      type: row!.type,
      scopes,
      ip_allowlist: ipAllowlist,
      daily_credit_cap: dailyCreditCap,
      monthly_credit_cap: monthlyCreditCap,
      expires_at: row!.expiresAt.toISOString(),
    });
    return { ...keyView(row!, now), key };
  });
}

export async function listPublicApiKeys(db: Db, workspaceId: string, now = new Date()): Promise<ApiKeyView[]> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.workspaceId, workspaceId)).orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => keyView(r, now));
}

async function loadKeyForUpdate(tx: Db, workspaceId: string, keyId: string) {
  const [row] = await tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)))
    .for("update")
    .limit(1);
  if (!row) throw new HttpError("Key not found", 404);
  return row;
}

/**
 * Rotation (KEY-7): issues a replacement with the same settings and a fresh 90-day expiry. The old
 * key keeps working for the chosen grace period (0, 24 h or 7 days), never past its own expiry; with
 * no grace it is revoked at once. Returns the new key in full, once.
 */
export async function rotatePublicApiKey(
  db: Db,
  cfg: KeyServiceConfig,
  actor: KeyActor,
  keyId: string,
  graceHours: number,
  now = new Date()
): Promise<{ old: ApiKeyView; replacement: ApiKeyView & { key: string } }> {
  const pepper = requirePepper(cfg);
  if (!(ROTATION_GRACE_HOURS as readonly number[]).includes(graceHours)) {
    throw new HttpError("Grace period must be 0, 24 or 168 hours", 422);
  }
  const [existing] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, actor.workspaceId)))
    .limit(1);
  if (!existing) throw new HttpError("Key not found", 404);
  await assertCanCreate(db, actor.workspaceId, existing.type as ApiKeyType, actor.userId);

  const rotated = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockWorkspaceKeys(tx, actor.workspaceId);
    const old = await loadKeyForUpdate(tx, actor.workspaceId, keyId);
    const status = keyStatus(old, now);
    if (status !== "active") throw new HttpError(`Only an active key can be rotated (this one is ${status})`, 409);
    const { key, prefix, hmac } = generatePublicApiKey(old.type as ApiKeyType, pepper);
    const [replacement] = await tx
      .insert(apiKeys)
      .values({
        workspaceId: old.workspaceId,
        createdBy: actor.userId,
        name: old.name,
        type: old.type,
        prefix,
        keyHmac: hmac,
        scopes: old.scopes,
        ipAllowlist: old.ipAllowlist,
        dailyCreditCap: old.dailyCreditCap,
        monthlyCreditCap: old.monthlyCreditCap,
        expiresAt: new Date(now.getTime() + MAX_KEY_LIFETIME_DAYS * DAY_MS),
        createdAt: now,
      })
      .returning();
    const graceEnd = new Date(Math.min(now.getTime() + graceHours * 3_600_000, old.expiresAt.getTime()));
    const [updated] = await tx
      .update(apiKeys)
      .set(
        graceHours === 0
          ? { replacedBy: replacement!.id, revokedAt: now, revokeReason: "rotated" }
          : { replacedBy: replacement!.id, graceUntil: graceEnd }
      )
      .where(eq(apiKeys.id, old.id))
      .returning();
    await auditKey(
      tx,
      actor,
      old.id,
      "api_key.rotated",
      { masked_key: maskKey(old.type, old.prefix) },
      {
        replaced_by: replacement!.id,
        replacement_masked_key: maskKey(replacement!.type, replacement!.prefix),
        grace_until: graceHours === 0 ? null : graceEnd.toISOString(),
      }
    );
    return { old: keyView(updated!, now), replacement: { ...keyView(replacement!, now), key }, oldPrefix: old.prefix };
  });
  // KEY-9: the old key's grace period (or revocation) must reach every instance's cache.
  await notifyPublicKeyChange({ prefixes: [rotated.oldPrefix] });
  return { old: rotated.old, replacement: rotated.replacement };
}

export async function revokePublicApiKey(db: Db, actor: KeyActor, keyId: string, reason: string, now = new Date()): Promise<ApiKeyView> {
  const why = reason?.trim();
  if (!why) throw new HttpError("Give a reason for revoking the key", 422);
  const revoked = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const row = await loadKeyForUpdate(tx, actor.workspaceId, keyId);
    if (row.revokedAt) return { view: keyView(row, now), prefix: row.prefix };
    const [updated] = await tx.update(apiKeys).set({ revokedAt: now, revokeReason: why }).where(eq(apiKeys.id, row.id)).returning();
    await auditKey(tx, actor, row.id, "api_key.revoked", { masked_key: maskKey(row.type, row.prefix), status: keyStatus(row, now) }, { status: "revoked" }, why);
    return { view: keyView(updated!, now), prefix: row.prefix };
  });
  // KEY-9: revocation reaches every instance within seconds, not after the cache TTL.
  await notifyPublicKeyChange({ prefixes: [revoked.prefix] });
  return revoked.view;
}

export interface UpdateKeyInput {
  name?: string;
  scopes?: string[];
  ipAllowlist?: string[];
  dailyCreditCap?: number | null;
  monthlyCreditCap?: number | null;
  /** Can only move earlier (KEY-5), and must stay in the future. */
  expiresAt?: Date;
}

/**
 * Edits a key's name, scopes, IP allowlist, caps or expiry (PAPI-027). Expiry can only be shortened.
 * Each change is audited with before/after values (KEY-12) and dropped from every instance's key
 * cache, so new scopes or a tighter allowlist apply within seconds.
 */
export async function updatePublicApiKey(db: Db, actor: KeyActor, keyId: string, input: UpdateKeyInput, now = new Date()): Promise<ApiKeyView> {
  const changes: Partial<typeof apiKeys.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new HttpError("Give the key a name (up to 100 characters)", 422);
    changes.name = name;
  }
  if (input.scopes !== undefined) changes.scopes = validateScopes(input.scopes);
  if (input.ipAllowlist !== undefined) changes.ipAllowlist = validateIpAllowlist(input.ipAllowlist);
  if (input.dailyCreditCap !== undefined) changes.dailyCreditCap = validateCap(input.dailyCreditCap, "Daily credit cap");
  if (input.monthlyCreditCap !== undefined) changes.monthlyCreditCap = validateCap(input.monthlyCreditCap, "Monthly credit cap");
  if (Object.keys(changes).length === 0 && input.expiresAt === undefined) throw new HttpError("Nothing to change", 422);

  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const row = await loadKeyForUpdate(tx, actor.workspaceId, keyId);
    const status = keyStatus(row, now);
    if (status === "revoked" || status === "expired") throw new HttpError(`A ${status} key can't be changed`, 409);
    if (input.expiresAt !== undefined) {
      const at = input.expiresAt;
      if (Number.isNaN(at.getTime()) || at <= now) throw new HttpError("The new expiry must be in the future", 422);
      if (at > row.expiresAt) throw new HttpError("A key's expiry can only be shortened; rotate the key for a fresh 90 days", 422);
      changes.expiresAt = at;
      if (row.graceUntil && row.graceUntil > at) changes.graceUntil = at;
    }
    const [updated] = await tx.update(apiKeys).set(changes).where(eq(apiKeys.id, row.id)).returning();
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const fields: [keyof typeof changes, string][] = [
      ["name", "name"],
      ["scopes", "scopes"],
      ["ipAllowlist", "ip_allowlist"],
      ["dailyCreditCap", "daily_credit_cap"],
      ["monthlyCreditCap", "monthly_credit_cap"],
      ["expiresAt", "expires_at"],
    ];
    for (const [field, label] of fields) {
      if (changes[field] === undefined) continue;
      const fmt = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
      before[label] = fmt(row[field as keyof typeof row]);
      after[label] = fmt(updated![field as keyof typeof updated]);
    }
    await auditKey(tx, actor, row.id, "api_key.updated", { masked_key: maskKey(row.type, row.prefix), ...before }, after);
    return { view: keyView(updated!, now), prefix: row.prefix };
  });
  await notifyPublicKeyChange({ prefixes: [result.prefix] });
  return result.view;
}
