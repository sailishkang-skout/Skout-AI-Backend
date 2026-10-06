import { describe, expect, it } from "vitest";
import {
  applyCopsTransition,
  CopsIllegalTransitionError,
  CopsLifecycleProjectionError,
  deriveCopsLifecycleState,
  type CopsLifecycleTransitionEvent,
} from "./cops-lifecycle.js";
import {
  copsErrorBody,
  copsErrorStatus,
  resolveCorrelationId,
} from "./cops-platform.js";

const actor = { type: "user" as const, id: "u_1" };

describe("applyCopsTransition", () => {
  it("records an allowed transition with actor, source and reason", () => {
    const at = new Date("2026-10-06T10:00:00.000Z");
    const r = applyCopsTransition({
      dimension: "opportunity",
      from: "qualified",
      to: "demo",
      actor,
      source: "crm.kanban",
      reason: "Discovery call done",
      at,
    });

    describe("deriveCopsLifecycleState", () => {
      const history: CopsLifecycleTransitionEvent[] = [
        {
          dimension: "opportunity",
          entityId: "deal-1",
          from: "qualified",
          to: "demo",
          actor,
          source: "crm",
          reason: "Discovery call scheduled",
          occurredAt: new Date("2026-10-06T10:00:00.000Z"),
        },
        {
          dimension: "opportunity",
          entityId: "deal-1",
          from: "demo",
          to: "commercial",
          actor,
          source: "crm",
          reason: "Demo completed",
          occurredAt: new Date("2026-10-06T11:00:00.000Z"),
        },
      ];

      it("rebuilds state and timestamp from the immutable ordered transition history", () => {
        expect(deriveCopsLifecycleState(history, "opportunity", "deal-1")).toEqual({
          state: "commercial",
          updatedAt: new Date("2026-10-06T11:00:00.000Z"),
        });
      });

      it("returns null when there is no transition history", () => {
        expect(deriveCopsLifecycleState([], "opportunity", "deal-1")).toBeNull();
      });

      it("rebuilds the qualified baseline from the CRM qualification event timestamp", () => {
        const occurredAt = new Date("2026-10-06T09:00:00.000Z");
        expect(deriveCopsLifecycleState([], "opportunity", "deal-1", occurredAt)).toEqual({
          state: "qualified",
          updatedAt: occurredAt,
        });
      });

      it("rejects discontinuous event history instead of silently projecting an invalid state", () => {
        expect(() =>
          deriveCopsLifecycleState(
            [{ ...history[1]!, from: "qualified" }],
            "opportunity",
            "deal-1"
          )
        ).toThrow(CopsLifecycleProjectionError);
      });
    });
    expect(r).toMatchObject({ dimension: "opportunity", from: "qualified", to: "demo", source: "crm.kanban", at });
  });

  it("rejects an illegal move with the 409 business-state code", () => {
    try {
      applyCopsTransition({
        dimension: "opportunity",
        from: "lost",
        to: "demo",
        actor,
        source: "crm",
        reason: "reopen",
      });
      throw new Error("expected a conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(CopsIllegalTransitionError);
      expect((err as CopsIllegalTransitionError).code).toBe("BUSINESS_STATE_CONFLICT");
      expect((err as CopsIllegalTransitionError).status).toBe(409);
    }
  });

  it("requires a reason", () => {
    expect(() =>
      applyCopsTransition({ dimension: "health", from: "healthy", to: "watch", actor, source: "job", reason: " " })
    ).toThrow(/reason/);
  });

  it("closed-won does not imply activated: onboarding is unaffected by opportunity", () => {
    const won = applyCopsTransition({
      dimension: "opportunity",
      from: "commercial",
      to: "won",
      actor,
      source: "crm",
      reason: "Signed",
    });
    expect(won.to).toBe("won");
    expect(() =>
      applyCopsTransition({
        dimension: "onboarding",
        from: "not_started",
        to: "activated",
        actor,
        source: "crm",
        reason: "should not jump",
      })
    ).toThrow(CopsIllegalTransitionError);
  });
});

describe("copsErrorBody and status", () => {
  it("builds the envelope with request id and null details by default", () => {
    expect(copsErrorBody({ code: "FORBIDDEN", message: "No", requestId: "req_1" })).toEqual({
      code: "FORBIDDEN",
      message: "No",
      details: null,
      request_id: "req_1",
      retryable: false,
    });
  });

  it("maps codes to HTTP statuses", () => {
    expect(copsErrorStatus("VALIDATION_FAILED")).toBe(422);
    expect(copsErrorStatus("BUSINESS_STATE_CONFLICT")).toBe(409);
    expect(copsErrorStatus("RATE_LIMITED")).toBe(429);
    expect(copsErrorStatus("FORBIDDEN")).toBe(403);
  });
});

describe("resolveCorrelationId", () => {
  it("keeps a valid inbound UUID and lowercases it", () => {
    expect(resolveCorrelationId("6F1C2A7E-8B1D-4C2E-9F3A-1A2B3C4D5E70")).toBe("6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e70");
  });

  it("generates a fresh UUID for missing or invalid input", () => {
    const a = resolveCorrelationId(undefined);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId("not-a-uuid")).not.toBe("not-a-uuid");
  });
});
