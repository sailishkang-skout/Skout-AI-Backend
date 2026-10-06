import { describe, expect, it, vi } from "vitest";
import { handleDexterEvent } from "./dexter-event.worker.js";

const event = {
  event_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e6f",
  event_type: "OpportunityQualified",
  schema_version: 1,
  tenant_id: "ws-1",
  aggregate_type: "opportunity",
  aggregate_id: "deal-1",
  occurred_at: "2026-10-06T10:00:00.000Z",
  actor: { type: "user", id: "user-1" },
  correlation_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e70",
  causation_id: null,
  payload: { opportunity_id: "deal-1", account_id: "company-1" },
} as const;

function makeDb(claimed: boolean) {
  const returning = vi.fn().mockResolvedValue(claimed ? [{ eventId: event.event_id }] : []);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as never, insert, values, onConflictDoNothing, returning };
}

describe("handleDexterEvent COPS envelope handling", () => {
  it("validates and records a COPS event on the existing event worker", async () => {
    const mocks = makeDb(true);

    await handleDexterEvent(event, mocks.db);

    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.values).toHaveBeenCalledWith({
      consumer: "skout-dexter-event",
      eventId: event.event_id,
    });
  });

  it("ignores duplicate COPS deliveries", async () => {
    const mocks = makeDb(false);

    await expect(handleDexterEvent(event, mocks.db)).resolves.toBeUndefined();
    expect(mocks.insert).toHaveBeenCalledOnce();
  });

  it("requires the existing database for idempotent COPS handling", async () => {
    await expect(handleDexterEvent(event, null)).rejects.toThrow(/DATABASE_URL/);
  });
});
