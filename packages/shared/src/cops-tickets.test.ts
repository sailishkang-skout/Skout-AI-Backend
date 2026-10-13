import { describe, expect, it } from "vitest";
import {
  canTransitionTicket,
  inheritedTicketVisibility,
  maxTicketSeverity,
  sanitizeTicketDiagnostics,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
} from "./cops-tickets.js";

describe("COPS-06 ticket state machine", () => {
  it("walks the documented path New -> ... -> Closed", () => {
    for (let i = 0; i < TICKET_STATUSES.length - 1; i++) {
      expect(canTransitionTicket(TICKET_STATUSES[i]!, TICKET_STATUSES[i + 1]!)).toBe(true);
    }
  });

  it("refuses skipping ahead and leaving closed", () => {
    expect(canTransitionTicket("new", "resolved")).toBe(false);
    expect(canTransitionTicket("in_progress", "verified")).toBe(false);
    expect(TICKET_TRANSITIONS.closed).toEqual([]);
  });

  it("a rejected resolution reopens the work", () => {
    expect(canTransitionTicket("resolved", "in_progress")).toBe(true);
  });
});

describe("COPS-06 visibility and diagnostics", () => {
  it("a derived comment is customer-safe only when every source is", () => {
    expect(inheritedTicketVisibility(["customer", "customer"])).toBe("customer");
    expect(inheritedTicketVisibility(["customer", "internal"])).toBe("internal");
    expect(inheritedTicketVisibility([])).toBe("internal");
  });

  it("finds the highest severity", () => {
    expect(maxTicketSeverity(["low", "critical", "high"])).toBe("critical");
    expect(maxTicketSeverity([])).toBeNull();
  });

  it("keeps only allowlisted diagnostics and drops anything secret-like", () => {
    const safe = sanitizeTicketDiagnostics({
      plan: "trial",
      activation_pct: 35,
      integrations: [{ key: "crm", status: "error", access_token: "abc" }],
      error_code: "Bearer abcdefghijkl",
      contract_value: 50000,
      api_key: "sk-123",
    });
    expect(safe).toEqual({ plan: "trial", activation_pct: 35, integrations: [{ key: "crm", status: "error" }] });
    expect(sanitizeTicketDiagnostics("nope")).toEqual({});
  });
});
