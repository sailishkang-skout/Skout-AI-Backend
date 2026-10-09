import { describe, expect, it } from "vitest";
import { COPS_PHASE1_EVENTS, createCopsEvent, parseCopsEvent } from "./copos-events.js";

const base = {
  event_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e6f",
  schema_version: 1,
  tenant_id: "ws_1",
  aggregate_type: "opportunity",
  aggregate_id: "opp_1",
  occurred_at: "2026-10-06T10:00:00.000Z",
  actor: { type: "user", id: "u_1" },
  correlation_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e70",
  causation_id: null,
};

describe("COPS Phase 1 event contract", () => {
  it("registers the 17 Phase 1 business events, LifecycleTransitioned, the COPS-02 task/activity events and COPS-03 ProvisioningRequested", () => {
    expect(Object.keys(COPS_PHASE1_EVENTS)).toHaveLength(21);
    expect(COPS_PHASE1_EVENTS).toHaveProperty("LifecycleTransitioned");
    expect(COPS_PHASE1_EVENTS).toHaveProperty("ProvisioningRequested");
  });

  it("accepts a valid envelope with a matching payload", () => {
    const parsed = parseCopsEvent({
      ...base,
      event_type: "OpportunityQualified",
      payload: { opportunity_id: "opp_1", account_id: "acc_1" },
    });
    expect(parsed.payload).toEqual({ opportunity_id: "opp_1", account_id: "acc_1" });
  });

  it("creates a validated COPS envelope with stable event/correlation ids", () => {
    const event = createCopsEvent({
      eventType: "OpportunityQualified",
      tenantId: "ws_1",
      aggregateType: "opportunity",
      aggregateId: "opp_1",
      actor: { type: "user", id: "u_1" },
      payload: { opportunity_id: "opp_1", account_id: "acc_1" },
    });
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.correlation_id).toBe(event.event_id);
    expect(event.event_type).toBe("OpportunityQualified");
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      parseCopsEvent({ ...base, event_type: "OpportunityUnknown", payload: {} })
    ).toThrow(/Unknown COPS event_type/);
  });

  it("rejects a payload missing required fields", () => {
    expect(() =>
      parseCopsEvent({ ...base, event_type: "ContractSigned", payload: { contract_id: "c_1" } })
    ).toThrow();
  });

  it("rejects an unknown schema_version", () => {
    expect(() =>
      parseCopsEvent({
        ...base,
        schema_version: 2,
        event_type: "TaskCreated",
        payload: { task_id: "t", account_id: "a", task_type: "call" },
      })
    ).toThrow();
  });

  it("accepts a TaskCompleted event with a null account", () => {
    expect(() =>
      parseCopsEvent({
        ...base,
        event_type: "TaskCompleted",
        payload: { task_id: "t", account_id: null, task_type: "call" },
      })
    ).not.toThrow();
  });

  it("rejects an actor type outside the allowed set", () => {
    expect(() =>
      parseCopsEvent({
        ...base,
        actor: { type: "robot", id: null },
        event_type: "FirstLogin",
        payload: { account_id: "a", user_id: "u" },
      })
    ).toThrow();
  });
});
