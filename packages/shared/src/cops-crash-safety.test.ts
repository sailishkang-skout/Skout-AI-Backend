import { describe, expect, it } from "vitest";
import { processCopsEventOnce, relayCopsOutboxRow, type CopsProcessedStore } from "./cops-relay.js";

/**
 * Acceptance: "killing the process between commit and publish never loses or duplicates an effect;
 * duplicate event_id is a no-op." Simulated with an in-memory outbox and processed-event store.
 */
type Row = { id: string; attempts: number; envelope: unknown; publishedAt: Date | null };

function memoryOutbox() {
  const rows = new Map<string, Row>();
  return {
    rows,
    // Same transaction as the state change: both writes succeed or neither is visible.
    commitStateChange(id: string, envelope: unknown, stateWrite: () => void, fail = false) {
      if (fail) throw new Error("crash before commit");
      stateWrite();
      rows.set(id, { id, attempts: 0, envelope, publishedAt: null });
    },
  };
}

describe("crash safety of the outbox", () => {
  it("a crash before commit leaves neither the state change nor the event", () => {
    const outbox = memoryOutbox();
    let state = "qualified";
    expect(() =>
      outbox.commitStateChange("evt_1", { event_id: "evt_1" }, () => (state = "demo"), true)
    ).toThrow();
    expect(state).toBe("qualified");
    expect(outbox.rows.size).toBe(0);
  });

  it("a crash after commit but before publish is recovered on the next relay pass", async () => {
    const outbox = memoryOutbox();
    outbox.commitStateChange("evt_2", { event_id: "evt_2" }, () => {});
    // Process dies here: nothing published yet. A restarted relay sees the unpublished row.
    const row = outbox.rows.get("evt_2")!;
    const result = await relayCopsOutboxRow(row, async () => {});
    expect(result.kind).toBe("published");
  });

  it("publish succeeds but write-back is lost: the re-run republishes, and the consumer skips it", async () => {
    const published: string[] = [];
    const processed = new Set<string>();
    const store: CopsProcessedStore = {
      insertIfAbsent: async (c, e) => {
        const k = `${c}:${e}`;
        if (processed.has(k)) return false;
        processed.add(k);
        return true;
      },
    };
    let effects = 0;
    const handler = async () => {
      effects++;
    };
    const row = { id: "evt_3", attempts: 0, envelope: { event_id: "evt_3" } };

    // First relay pass: publish ok, then the process dies before the row is stamped published.
    await relayCopsOutboxRow(row, async (env) => {
      published.push((env as { event_id: string }).event_id);
    });
    // Second pass after restart: the row is still unpublished, so it is published again.
    await relayCopsOutboxRow(row, async (env) => {
      published.push((env as { event_id: string }).event_id);
    });
    expect(published).toEqual(["evt_3", "evt_3"]);

    // Consumer receives both deliveries; the side effect runs exactly once.
    const first = await processCopsEventOnce(store, "crm", "evt_3", handler);
    const second = await processCopsEventOnce(store, "crm", "evt_3", handler);
    expect(first).toBe("processed");
    expect(second).toBe("duplicate");
    expect(effects).toBe(1);
  });
});
