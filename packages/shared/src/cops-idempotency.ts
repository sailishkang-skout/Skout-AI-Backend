import { createHash } from "node:crypto";

export const COPS_IDEMPOTENCY_KEY_MIN = 8;
export const COPS_IDEMPOTENCY_KEY_MAX = 128;
export const COPS_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const COPS_IDEMPOTENCY_PENDING_MS = 2 * 60 * 1_000;

export function isValidIdempotencyKey(key: string): boolean {
  return key.length >= COPS_IDEMPOTENCY_KEY_MIN && key.length <= COPS_IDEMPOTENCY_KEY_MAX;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export interface StoredOutcome {
  requestHash: string;
  state: "pending" | "complete";
  status: number | null;
  response: unknown | null;
  expiresAt: Date;
}

export type IdempotencyDecision =
  | { kind: "reserved" }
  | { kind: "in_progress" }
  | { kind: "replay"; status: number; response: unknown }
  | { kind: "conflict" }
  | { kind: "invalid_key" };

export interface IdempotencyStore {
  reserve: (
    scope: string,
    key: string,
    requestHash: string,
    now: Date,
    pendingUntil: Date
  ) => Promise<IdempotencyDecision>;
  complete: (
    scope: string,
    key: string,
    requestHash: string,
    status: number,
    response: unknown,
    expiresAt: Date
  ) => Promise<void>;
  release: (scope: string, key: string, requestHash: string) => Promise<void>;
}

/**
 * Atomically reserve a key before executing a mutating handler. Concurrent retries with the
 * same body receive in_progress; a different body receives conflict.
 */
export async function reserveIdempotency(
  store: IdempotencyStore,
  scope: string,
  key: string,
  body: unknown,
  now: Date = new Date()
): Promise<IdempotencyDecision> {
  if (!isValidIdempotencyKey(key)) return { kind: "invalid_key" };
  return store.reserve(
    scope,
    key,
    hashRequestBody(body),
    now,
    new Date(now.getTime() + COPS_IDEMPOTENCY_PENDING_MS)
  );
}

export async function completeIdempotency(
  store: IdempotencyStore,
  scope: string,
  key: string,
  body: unknown,
  status: number,
  response: unknown,
  now: Date = new Date()
): Promise<void> {
  await store.complete(
    scope,
    key,
    hashRequestBody(body),
    status,
    response,
    new Date(now.getTime() + COPS_IDEMPOTENCY_TTL_MS)
  );
}
