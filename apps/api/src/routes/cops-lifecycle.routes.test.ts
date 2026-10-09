import { describe, expect, it } from "vitest";
import {
  COPS_LIFECYCLE_BODY_SCHEMA,
  COPS_LIFECYCLE_PARAMS_SCHEMA,
  COPS_LIFECYCLE_RECOMPUTE_BODY_SCHEMA,
} from "./cops-lifecycle.routes.js";
import { COPS_STATES, applyCopsTransition, CopsIllegalTransitionError } from "@skout/shared";

describe("COPS lifecycle transition contract", () => {
  it("accepts a UUID entity and a reasoned transition", () => {
    expect(
      COPS_LIFECYCLE_PARAMS_SCHEMA.safeParse({
        dimension: "onboarding",
        entityId: "d06a12e4-628b-437f-8f96-1f23c7823658",
      }).success
    ).toBe(true);
    expect(COPS_LIFECYCLE_BODY_SCHEMA.safeParse({ to: "in_progress", source: "web", reason: "Kickoff started" }).success).toBe(true);
  });

  describe("COPS lifecycle recompute contract", () => {
    it("requires an auditable reason and rejects unexpected fields", () => {
      expect(COPS_LIFECYCLE_RECOMPUTE_BODY_SCHEMA.safeParse({ reason: "Repair projection" }).success).toBe(true);
      expect(COPS_LIFECYCLE_RECOMPUTE_BODY_SCHEMA.safeParse({ reason: "short" }).success).toBe(false);
      expect(COPS_LIFECYCLE_RECOMPUTE_BODY_SCHEMA.safeParse({ reason: "Repair projection", state: "won" }).success).toBe(false);
    });
  });

  it("rejects unknown dimensions, empty source/reason and unexpected body fields", () => {
    expect(
      COPS_LIFECYCLE_PARAMS_SCHEMA.safeParse({
        dimension: "billing",
        entityId: "d06a12e4-628b-437f-8f96-1f23c7823658",
      }).success
    ).toBe(false);
    expect(COPS_LIFECYCLE_BODY_SCHEMA.safeParse({ to: "activated", source: " ", reason: "" }).success).toBe(false);
    expect(
      COPS_LIFECYCLE_BODY_SCHEMA.safeParse({ to: "activated", source: "web", reason: "Done", actorId: "spoof" }).success
    ).toBe(false);
  });

  it("keeps lifecycle dimensions independent and rejects illegal progressions", () => {
    expect(COPS_STATES.opportunity).toContain("won");
    expect(COPS_STATES.onboarding).toContain("activated");
    expect(() =>
      applyCopsTransition({
        dimension: "onboarding",
        from: "not_started",
        to: "activated",
        actor: { type: "user", id: "d06a12e4-628b-437f-8f96-1f23c7823658" },
        source: "api",
        reason: "Cannot skip onboarding",
      })
    ).toThrow(CopsIllegalTransitionError);
  });
});
