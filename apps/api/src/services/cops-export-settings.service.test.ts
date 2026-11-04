import { describe, expect, it } from "vitest";
import { EXPORTABLE_EVENT_TYPES, exportAllowed } from "./cops-export-settings.service.js";

describe("COPS-14 warehouse export settings", () => {
  it("exports everything when a workspace has not chosen", () => {
    expect(exportAllowed(undefined, "TicketCreated")).toBe(true);
  });
  it("exports nothing when the workspace turned it off", () => {
    expect(exportAllowed({ enabled: false, eventTypes: null }, "TicketCreated")).toBe(false);
  });
  it("exports only the chosen types", () => {
    const s = { enabled: true, eventTypes: ["CustomerActivated"] };
    expect(exportAllowed(s, "CustomerActivated")).toBe(true);
    expect(exportAllowed(s, "PaymentSucceeded")).toBe(false);
  });
  it("offers the registered domain events", () => {
    expect(EXPORTABLE_EVENT_TYPES).toEqual(expect.arrayContaining(["TaskCreated", "CustomerActivated"]));
  });
});
