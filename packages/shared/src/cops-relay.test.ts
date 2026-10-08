import { describe, expect, it, vi } from "vitest";
import { COPS_OUTBOX_MAX_ATTEMPTS } from "./cops-outbox.js";
import { consumeCopsEvent, processCopsEventOnce, relayCopsOutboxRow } from "./cops-relay.js";

const now = new Date("2026-10-06T10:00:00.000Z");
const row = { id: "evt_1", attempts: 0, envelope: { event_id: "evt_1" } };

describe("relayCopsOutboxRow", () => {
  it("marks the row published when publish succeeds", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const result = await relayCopsOutboxRow(row, publish, now);
    expect(publish).toHaveBeenCalledWith(row.envelope);
    expect(result).toEqual({ kind: "published", publishedAt: now });
  });

  it("schedules a retry with backoff after a failure", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("redis down"));
    const result = await relayCopsOutboxRow(row, publish, now);
    expect(result).toEqual({
      kind: "retry",
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + 1_000),
      lastError: "redis down",
    });
  });

  it("dead-letters the row once the attempt limit is reached", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("still down"));
    const exhausted = { ...row, attempts: COPS_OUTBOX_MAX_ATTEMPTS - 1 };
    const result = await relayCopsOutboxRow(exhausted, publish, now);
    expect(result).toEqual({
      kind: "dead_letter",
      attempts: COPS_OUTBOX_MAX_ATTEMPTS,
      deadLetteredAt: now,
      lastError: "still down",
    });
  });
});

describe("processCopsEventOnce", () => {
  it("runs the handler once and reports duplicates without running it again", async () => {
    const claimed = new Set<string>();
    const store = {
      insertIfAbsent: async (c: string, e: string) => {
        const key = `${c}:${e}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    };
    const handler = vi.fn().mockResolvedValue(undefined);

    expect(await processCopsEventOnce(store, "crm", "evt_1", handler)).toBe("processed");
    expect(await processCopsEventOnce(store, "crm", "evt_1", handler)).toBe("duplicate");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the handler fails so a retry can run", async () => {
    const claimed = new Set<string>();
    const store = {
      insertIfAbsent: async (c: string, e: string) => {
        const key = `${c}:${e}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      release: async (c: string, e: string) => {
        claimed.delete(`${c}:${e}`);
      },
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(processCopsEventOnce(store, "crm", "evt_2", failing)).rejects.toThrow("boom");

    const ok = vi.fn().mockResolvedValue(undefined);
    expect(await processCopsEventOnce(store, "crm", "evt_2", ok)).toBe("processed");
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("consumeCopsEvent", () => {
  it("passes the correlation id through and skips duplicates", async () => {
    const seen = new Set<string>();
    const store = {
      insertIfAbsent: async (c: string, e: string) => {
        const k = `${c}:${e}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      },
    };
    const event = {
      event_id: "evt_9",
      event_type: "TicketCreated",
      correlation_id: "corr_9",
      tenant_id: "ws_1",
    };
    const handler = vi.fn().mockResolvedValue(undefined);
    const first = await consumeCopsEvent(store, "notify", event, handler);
    const second = await consumeCopsEvent(store, "notify", event, handler);
    expect(first).toEqual({ outcome: "processed", correlationId: "corr_9" });
    expect(second.outcome).toBe("duplicate");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
