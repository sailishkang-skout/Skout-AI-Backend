import { and, desc, eq, ilike } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { signToken, verifyToken } from "../utils/signed-token.js";

const { suppressions } = schema;

export interface SuppressionDto {
  id: string;
  workspaceId: string;
  email: string;
  reason: string;
  createdAt: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function trackingSecret(config: Env): string {
  return config.TRACKING_SIGNING_SECRET ?? config.INTEGRATION_ENCRYPTION_KEY ?? "dev-insecure-tracking-secret";
}

export async function isSuppressed(db: Db, workspaceId: string, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, workspaceId), eq(suppressions.email, normalizeEmail(email))))
    .limit(1);
  return !!row;
}

function toSuppressionDto(row: typeof suppressions.$inferSelect): SuppressionDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSuppressions(
  db: Db,
  workspaceId: string,
  options: { email?: string; limit?: number; offset?: number } = {}
): Promise<{ data: SuppressionDto[]; total: number }> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;
  const conditions = [eq(suppressions.workspaceId, workspaceId)];
  if (options.email?.trim()) {
    conditions.push(ilike(suppressions.email, `%${normalizeEmail(options.email)}%`));
  }

  const rows = await db
    .select()
    .from(suppressions)
    .where(and(...conditions))
    .orderBy(desc(suppressions.createdAt))
    .limit(limit)
    .offset(offset);

  const all = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(...conditions));

  return { data: rows.map(toSuppressionDto), total: all.length };
}

export async function addSuppression(
  db: Db,
  workspaceId: string,
  email: string,
  reason = "unsubscribed"
): Promise<SuppressionDto> {
  const [row] = await db
    .insert(suppressions)
    .values({ workspaceId, email: normalizeEmail(email), reason })
    .onConflictDoNothing()
    .returning();
  if (row) return toSuppressionDto(row);

  const [existing] = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, workspaceId), eq(suppressions.email, normalizeEmail(email))))
    .limit(1);
  if (!existing) throw new HttpError("suppression_create_failed", 500);
  return toSuppressionDto(existing);
}

export async function removeSuppression(db: Db, workspaceId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(suppressions)
    .where(and(eq(suppressions.id, id), eq(suppressions.workspaceId, workspaceId)))
    .returning({ id: suppressions.id });
  if (!row) throw new HttpError("suppression_not_found", 404);
}

interface UnsubscribeTokenPayload {
  workspaceId: string;
  email: string;
}

export function buildUnsubscribeUrl(config: Env, workspaceId: string, email: string): string {
  const token = signToken<UnsubscribeTokenPayload>(
    { workspaceId, email: normalizeEmail(email) },
    trackingSecret(config)
  );
  const base = config.API_PUBLIC_URL ?? `http://localhost:${config.PORT}`;
  return `${base}/api/v1/unsubscribe/${token}`;
}

export function decodeUnsubscribeToken(config: Env, token: string): UnsubscribeTokenPayload | null {
  return verifyToken<UnsubscribeTokenPayload>(token, trackingSecret(config));
}
