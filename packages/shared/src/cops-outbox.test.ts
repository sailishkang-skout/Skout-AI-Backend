import { describe, expect, it, vi } from "vitest";
import { appendCopsEvent, copsOutboxBackoffMs, COPS_OUTBOX_MAX_ATTEMPTS } from "./cops-outbox.js";

const valid = {
  event_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e6f",
  event_type: "OpportunityQualified",
  schema_version: 1,
  tenant_id: "ws_1",
  aggregate_type: "opportunity",
  aggregate_id: "opp_1",
  occurred_at: "2026-10-06T10:00:00.000Z",
  actor: { type: "user", id: "u_1" },
  correlation_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e70",
  causation_id: null,
  payload: { opportunity_id: "opp_1", account_id: "acc_1" },
};

function fakeTx() {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });
  return { tx: { insert } as never, insert, values };
}

describe("appendCopsEvent", () => {
  it("writes a validated envelope into the outbox inside the caller's transaction", async () => {
    const { tx, insert, values } = fakeTx();
    await appendCopsEvent(tx, valid);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: valid.event_id,
        tenantId: "ws_1",
        eventType: "OpportunityQualified",
        aggregateType: "opportunity",
        aggregateId: "opp_1",
      })
    );
  });

  it("rejects an invalid envelope before any write", async () => {
    const { tx, insert } = fakeTx();
    await expect(
      appendCopsEvent(tx, { ...valid, event_type: "NotAnEvent" })
    ).rejects.toThrow(/Unknown COPS event_type/);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("copsOutboxBackoffMs", () => {
  it("doubles from 1s", () => {
    expect(copsOutboxBackoffMs(1)).toBe(1_000);
    expect(copsOutboxBackoffMs(2)).toBe(2_000);
    expect(copsOutboxBackoffMs(3)).toBe(4_000);
  });

  it("caps at 15 minutes", () => {
    expect(copsOutboxBackoffMs(COPS_OUTBOX_MAX_ATTEMPTS + 20)).toBe(15 * 60 * 1_000);
  });
});
