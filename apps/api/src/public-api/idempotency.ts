import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { PublicApiError } from "./errors.js";

const { apiIdempotency } = schema;

/**
 * Idempotency-Key (PAPI-042, public API PRD CONV-2). Required on every billable POST. The same key
 * with the same request within 24 hours returns the original response and charges nothing new; the
 * same key with a different request is 409 idempotency_conflict. Keys are scoped to the workspace.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export type IdempotencyClaim =
  | { kind: "new"; key: string }
  | { kind: "replay"; key: string; status: number; body: unknown };

/** Stable JSON: object keys sorted, so the same body always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method.toUpperCase()} ${path}\n${canonical(body)}`).digest("hex");
}

/**
 * Claims a key for this request. Returns "new" when this request should run, or "replay" with the
 * stored response. Throws 422 when the header is missing or malformed, 409 when the key belongs to a
 * different request or its first request is still running.
 */
export async function claimIdempotencyKey(
  db: Db,
  input: { workspaceId: string; header: string | string[] | undefined; hash: string },
  now = new Date()
): Promise<IdempotencyClaim> {
  const raw = Array.isArray(input.header) ? input.header[0] : input.header;
  const key = raw?.trim();
  if (!key) throw new PublicApiError("invalid_request", "Send an Idempotency-Key header (e.g. a UUID) with this request so it can be retried safely.");
  if (!KEY_RE.test(key)) throw new PublicApiError("invalid_request", "The Idempotency-Key must be 1 to 255 printable ASCII characters.");

  // A record older than the window no longer counts (the maintenance job also purges it).
  await db
    .delete(apiIdempotency)
    .where(
      and(
        eq(apiIdempotency.workspaceId, input.workspaceId),
        eq(apiIdempotency.key, key),
        sql`${apiIdempotency.createdAt} <= ${new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS).toISOString()}::timestamptz`
      )
    );

  const inserted = await db
    .insert(apiIdempotency)
    .values({ workspaceId: input.workspaceId, key, requestHash: input.hash, createdAt: now })
    .onConflictDoNothing()
    .returning({ key: apiIdempotency.key });
  if (inserted.length > 0) return { kind: "new", key };

  const [row] = await db
    .select()
    .from(apiIdempotency)
    .where(and(eq(apiIdempotency.workspaceId, input.workspaceId), eq(apiIdempotency.key, key)))
    .limit(1);
  if (!row) return claimIdempotencyKey(db, input, now); // purged between the two statements
  if (row.requestHash !== input.hash) {
    throw new PublicApiError("idempotency_conflict", "This Idempotency-Key was already used for a different request. Use a new key for a new request.");
  }
  if (row.statusCode === null) {
    throw new PublicApiError("idempotency_conflict", "A request with this Idempotency-Key is still being processed. Retry shortly.");
  }
  return { kind: "replay", key, status: row.statusCode, body: row.response };
}

/** Stores the successful response so a retry replays it. */
export async function completeIdempotencyKey(db: Db, workspaceId: string, key: string, status: number, body: unknown): Promise<void> {
  await db
    .update(apiIdempotency)
    .set({ response: body as object, statusCode: status })
    .where(and(eq(apiIdempotency.workspaceId, workspaceId), eq(apiIdempotency.key, key)));
}

/** Frees the key after a failed request (nothing was charged), so the client can retry with it. */
export async function abandonIdempotencyKey(db: Db, workspaceId: string, key: string): Promise<void> {
  await db
    .delete(apiIdempotency)
    .where(and(eq(apiIdempotency.workspaceId, workspaceId), eq(apiIdempotency.key, key), sql`${apiIdempotency.statusCode} is null`));
}
