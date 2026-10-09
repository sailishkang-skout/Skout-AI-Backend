import { describe, expect, it } from "vitest";
import { COPS_TIMELINE_TYPES, projectCopsEventToTimeline } from "./cops-timeline.js";

describe("projectCopsEventToTimeline", () => {
  it("maps Phase 1 events onto the normalised timeline types", () => {
    expect(projectCopsEventToTimeline({ event_type: "ProposalSent" })?.type).toBe("proposal");
    expect(projectCopsEventToTimeline({ event_type: "ContractSigned" })?.type).toBe("contract");
    expect(projectCopsEventToTimeline({ event_type: "PaymentSucceeded" })?.type).toBe("payment");
    expect(projectCopsEventToTimeline({ event_type: "CustomerActivated" })?.type).toBe("product_milestone");
    expect(projectCopsEventToTimeline({ event_type: "TicketEscalated" })?.type).toBe("ticket");
  });

  it("returns null for events that are not customer-facing history", () => {
    expect(projectCopsEventToTimeline({ event_type: "NotARealEvent" })).toBeNull();
  });

  it("summarises a lifecycle transition from its payload", () => {
    const projection = projectCopsEventToTimeline({
      event_type: "LifecycleTransitioned",
      payload: { dimension: "opportunity", from: "qualified", to: "demo" },
    });
    expect(projection?.summary).toBe("opportunity: qualified → demo");
  });

  it("only produces types from the declared timeline type list", () => {
    for (const eventType of ["ProposalSent", "WelcomeEmailSent", "FirstLogin", "TicketResolved"]) {
      const projection = projectCopsEventToTimeline({ event_type: eventType });
      expect(COPS_TIMELINE_TYPES).toContain(projection!.type);
    }
  });

  it("maps a recorded activity to its timeline type and keeps internal notes internal", () => {
    const call = projectCopsEventToTimeline({ event_type: "ActivityRecorded", payload: { activity_type: "call", subject: "Intro call", visibility: "public" } });
    expect(call).toEqual({ type: "call", visibility: "public", summary: "Intro call" });
    const note = projectCopsEventToTimeline({ event_type: "ActivityRecorded", payload: { activity_type: "note", subject: null, visibility: "internal" } });
    expect(note).toEqual({ type: "note", visibility: "internal", summary: "Internal note" });
  });
});
