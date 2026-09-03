import { describe, expect, it } from "vitest";
import { findMissingDecisionMakers } from "./dashboard.service.js";

describe("findMissingDecisionMakers", () => {
  const decisionMakers = [
    { contactId: "dm-1", contactName: "Ava Buyer" },
    { contactId: "dm-2", contactName: "Ben Buyer" },
  ];

  it("returns the account decision maker that is not linked to the deal", () => {
    expect(findMissingDecisionMakers(decisionMakers, new Set(["dm-2"]))).toEqual([decisionMakers[0]]);
  });

  it("returns no flag candidates when every account decision maker is linked", () => {
    expect(findMissingDecisionMakers(decisionMakers, new Set(["dm-1", "dm-2"]))).toEqual([]);
  });
});