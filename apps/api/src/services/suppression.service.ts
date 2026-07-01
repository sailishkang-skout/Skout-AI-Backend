import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { signToken, verifyToken } from "../utils/signed-token.js";

const { suppressions } = schema;

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

export async function addSuppression(
  db: Db,
  workspaceId: string,
  email: string,
  reason = "unsubscribed"
): Promise<void> {
  await db
    .insert(suppressions)
    .values({ workspaceId, email: normalizeEmail(email), reason })
    .onConflictDoNothing();
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
