import { describe, expect, it } from "vitest";
import {
  completeIdempotency,
  COPS_IDEMPOTENCY_PENDING_MS,
  COPS_IDEMPOTENCY_TTL_MS,
  hashRequestBody,
  isValidIdempotencyKey,
  reserveIdempotency,
  type IdempotencyStore,
  type StoredOutcome,
} from "./cops-idempotency.js";

function memoryStore(): IdempotencyStore & { rows: Map<string, StoredOutcome> } {
  const rows = new Map<string, StoredOutcome>();
  return {
    rows,
    async reserve(scope, key, requestHash, now, pendingUntil) {
      const id = `${scope}:${key}`;
      const existing = rows.get(id);
      if (!existing || existing.expiresAt <= now) {
        rows.set(id, {
          requestHash,
          state: "pending",
          status: null,
          response: null,
          expiresAt: pendingUntil,
        });
        return { kind: "reserved" };
      }
      if (existing.requestHash !== requestHash) return { kind: "conflict" };
      if (existing.state === "complete" && existing.status !== null) {
        return { kind: "replay", status: existing.status, response: existing.response };
      }
      return { kind: "in_progress" };
    },
    async complete(scope, key, requestHash, status, response, expiresAt) {
      const id = `${scope}:${key}`;
      const row = rows.get(id);
      if (!row || row.requestHash !== requestHash || row.state !== "pending") {
        throw new Error("reservation missing");
      }
      rows.set(id, { requestHash, state: "complete", status, response, expiresAt });
    },
    async release(scope, key, requestHash) {
      const id = `${scope}:${key}`;
      const row = rows.get(id);
      if (row?.requestHash === requestHash && row.state === "pending") rows.delete(id);
    },
  };
}

const now = new Date("2026-10-06T10:00:00.000Z");
const body = { accountId: "acc_1" };

describe("isValidIdempotencyKey", () => {
  it("enforces 8 to 128 characters", () => {
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("long-enough-key")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
  });
});

describe("reserveIdempotency", () => {
  it("reserves a new key before the handler runs", async () => {
    const store = memoryStore();
    expect(await reserveIdempotency(store, "ws_1", "key-0001", body, now)).toEqual({ kind: "reserved" });
    expect(store.rows.get("ws_1:key-0001")?.expiresAt.getTime()).toBe(now.getTime() + COPS_IDEMPOTENCY_PENDING_MS);
  });

  it("blocks a concurrent duplicate while its first request is running", async () => {
    const store = memoryStore();
    const result = await Promise.all([
      reserveIdempotency(store, "ws_1", "key-0001", body, now),
      reserveIdempotency(store, "ws_1", "key-0001", body, now),
    ]);
    expect(result.map((r) => r.kind).sort()).toEqual(["in_progress", "reserved"]);
  });

  it("replays a completed outcome for the same key and body", async () => {
    const store = memoryStore();
    await reserveIdempotency(store, "ws_1", "key-0001", body, now);
    await completeIdempotency(store, "ws_1", "key-0001", body, 201, { id: "provisioned" }, now);
    expect(await reserveIdempotency(store, "ws_1", "key-0001", body, now)).toEqual({
      kind: "replay",
      status: 201,
      response: { id: "provisioned" },
    });
    expect(store.rows.get("ws_1:key-0001")?.expiresAt.getTime()).toBe(now.getTime() + COPS_IDEMPOTENCY_TTL_MS);
  });

  it("rejects reuse with a different body", async () => {
    const store = memoryStore();
    await reserveIdempotency(store, "ws_1", "key-0001", body, now);
    await completeIdempotency(store, "ws_1", "key-0001", body, 201, {}, now);
    expect(await reserveIdempotency(store, "ws_1", "key-0001", { accountId: "acc_2" }, now)).toEqual({
      kind: "conflict",
    });
  });

  it("scopes keys by workspace", async () => {
    const store = memoryStore();
    await reserveIdempotency(store, "ws_1", "key-0001", body, now);
    expect(await reserveIdempotency(store, "ws_2", "key-0001", body, now)).toEqual({ kind: "reserved" });
  });

  it("reclaims expired reservations and rejects invalid keys without touching storage", async () => {
    const store = memoryStore();
    expect(await reserveIdempotency(store, "ws_1", "bad", body, now)).toEqual({ kind: "invalid_key" });
    await reserveIdempotency(store, "ws_1", "key-0001", body, now);
    const later = new Date(now.getTime() + COPS_IDEMPOTENCY_PENDING_MS + 1);
    expect(await reserveIdempotency(store, "ws_1", "key-0001", body, later)).toEqual({ kind: "reserved" });
  });
});

describe("hashRequestBody", () => {
  it("canonicalizes object key order but preserves value changes", () => {
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(hashRequestBody({ b: 2, a: 1 }));
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }));
  });
});
