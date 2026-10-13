import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMERCIAL_POLICY_DEFAULT_DATA } from "./cops-commercial-policy.default.js";
import {
  APPROVER_DECIDED_BY,
  COMMERCIAL_POLICY_DEFAULTS,
  approvalPolicySchema,
  contractValueMinor,
  dunningDay,
  dunningPolicySchema,
  dunningStage,
  evaluateApprovals,
  materialChanges,
  seatMonthMinor,
  type ApprovalTerms,
  type MaterialTerms,
} from "./cops-commercial-policy.js";
import { COPS_CONFIG_DEFAULTS, COPS_CONFIG_SCHEMAS } from "./cops-admin-config.js";
import { proposalApprovalTerms, proposalContentHash } from "./cops-commercial.js";

const policy = COMMERCIAL_POLICY_DEFAULTS.approval_policy;
/** A deal under every threshold. */
const standard: ApprovalTerms = {
  currency: "USD",
  discount_pct: 0,
  seats: 10,
  contract_value_minor: 948_000,
  term_months: 12,
  free_credits: 0,
  payment_terms_net_days: 30,
  custom_clauses: false,
  non_standard_sla: false,
};
const approversFor = (terms: Partial<ApprovalTerms>) => evaluateApprovals(policy, { ...standard, ...terms }).required_approvers;

describe("COPS-08 commercial policy defaults", () => {
  it("the generated seed matches the policy file", () => {
    const strip = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_")).map(([k, x]) => [k, strip(x)])) : v;
    const file = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/ops/cops-commercial-policy.default.json", import.meta.url)), "utf8"));
    // If this fails, run: node scripts/sync-cops-commercial-policy.mjs
    expect(COMMERCIAL_POLICY_DEFAULT_DATA).toEqual(strip(file));
  });

  it("is the default of the three admin config kinds and passes their schemas", () => {
    for (const kind of ["approval_policy", "dunning_policy", "price_book"] as const) {
      const value = COPS_CONFIG_DEFAULTS[kind]?.default;
      expect(value).toEqual(COMMERCIAL_POLICY_DEFAULTS[kind]);
      expect(COPS_CONFIG_SCHEMAS[kind].safeParse(value).success).toBe(true);
    }
  });

  it("an Admin decides the executive slot", () => {
    expect(APPROVER_DECIDED_BY.executive).toBe("admin");
  });
});

describe("approval rules", () => {
  it("a deal under every threshold needs no approval", () => {
    const result = evaluateApprovals(policy, standard);
    expect(result).toEqual({ required_approvers: [], matched_rules: [], unevaluated: [] });
  });

  it("discount bands: up to 10 none, over 10 Sales Manager, over 20 plus Finance, over 30 plus Executive", () => {
    expect(approversFor({ discount_pct: 10 })).toEqual([]);
    expect(approversFor({ discount_pct: 10.01 })).toEqual(["sales_manager"]);
    expect(approversFor({ discount_pct: 20 })).toEqual(["sales_manager"]);
    expect(approversFor({ discount_pct: 20.5 })).toEqual(["sales_manager", "finance"]);
    expect(approversFor({ discount_pct: 30 })).toEqual(["sales_manager", "finance"]);
    expect(approversFor({ discount_pct: 31 })).toEqual(["sales_manager", "finance", "executive"]);
  });

  it("seats: over 25 Sales Manager, over 100 plus Finance", () => {
    expect(approversFor({ seats: 25 })).toEqual([]);
    expect(approversFor({ seats: 26 })).toEqual(["sales_manager"]);
    expect(approversFor({ seats: 100 })).toEqual(["sales_manager"]);
    expect(approversFor({ seats: 101 })).toEqual(["sales_manager", "finance"]);
  });

  it("contract value in USD: over 25k, 75k and 200k", () => {
    expect(approversFor({ contract_value_minor: 2_500_000 })).toEqual([]);
    expect(approversFor({ contract_value_minor: 2_500_001 })).toEqual(["sales_manager"]);
    expect(approversFor({ contract_value_minor: 7_500_001 })).toEqual(["sales_manager", "finance"]);
    expect(approversFor({ contract_value_minor: 20_000_001 })).toEqual(["sales_manager", "finance", "executive"]);
  });

  it("has contract-value thresholds for EUR, GBP and INR", () => {
    expect(approversFor({ currency: "EUR", contract_value_minor: 2_300_001 })).toEqual(["sales_manager"]);
    expect(approversFor({ currency: "GBP", contract_value_minor: 6_000_001 })).toEqual(["sales_manager", "finance"]);
    expect(approversFor({ currency: "INR", contract_value_minor: 200_000_000 })).toEqual([]);
    expect(approversFor({ currency: "INR", contract_value_minor: 1_600_000_001 })).toEqual(["sales_manager", "finance", "executive"]);
  });

  it("reports contract value as unevaluated in a currency with no thresholds, and still applies the other rules", () => {
    const result = evaluateApprovals(policy, { ...standard, currency: "AUD", contract_value_minor: 99_000_000, discount_pct: 15 });
    expect(result.unevaluated).toEqual(["contract_value"]);
    expect(result.required_approvers).toEqual(["sales_manager"]);
  });

  it("term over 24 months and payment terms over net 30 need Finance", () => {
    expect(approversFor({ term_months: 24 })).toEqual([]);
    expect(approversFor({ term_months: 25 })).toEqual(["finance"]);
    expect(approversFor({ payment_terms_net_days: 30 })).toEqual([]);
    expect(approversFor({ payment_terms_net_days: 45 })).toEqual(["finance"]);
  });

  it("custom clauses need Legal/RevOps; a non-standard SLA needs Legal/RevOps and Finance", () => {
    expect(approversFor({ custom_clauses: true })).toEqual(["legal_revops"]);
    expect(approversFor({ non_standard_sla: true })).toEqual(["finance", "legal_revops"]);
  });

  it("every matching rule applies and the approvers are the union", () => {
    const result = evaluateApprovals(policy, { ...standard, discount_pct: 12, seats: 150, custom_clauses: true });
    expect(result.matched_rules.map((m) => m.rule)).toEqual(["discount_pct", "seats", "custom_clauses"]);
    expect(result.required_approvers).toEqual(["sales_manager", "finance", "legal_revops"]);
  });

  it("a rule set to null is switched off", () => {
    const off = approvalPolicySchema.parse({ ...policy, free_credits: null, custom_clauses: null });
    expect(evaluateApprovals(off, { ...standard, free_credits: 1_000_000, custom_clauses: true }).required_approvers).toEqual([]);
  });

  it("the schema refuses overlapping bands, an open band before the last, and an unknown approver", () => {
    const bad = (discount_pct: unknown) => approvalPolicySchema.safeParse({ ...policy, discount_pct }).success;
    expect(bad([{ over: 10, up_to: 20, approvers: ["sales_manager"] }, { over: 15, up_to: null, approvers: ["finance"] }])).toBe(false);
    expect(bad([{ over: 10, up_to: null, approvers: ["sales_manager"] }, { over: 20, up_to: 30, approvers: ["finance"] }])).toBe(false);
    expect(bad([{ over: 10, up_to: null, approvers: ["ceo"] }])).toBe(false);
    expect(bad([{ over: 10, up_to: null, approvers: ["sales_manager"] }])).toBe(true);
  });

  it("names the terms whose change voids an approval; nothing for identical terms", () => {
    const before: MaterialTerms = { ...standard, billing_cadence: "annual", line_items_key: "a" };
    expect(materialChanges(before, { ...before })).toEqual([]);
    expect(materialChanges(before, { ...before, seats: 11, line_items_key: "b" })).toEqual(["seats", "line_items_key"]);
  });
});

describe("failed payment timeline", () => {
  const dunning = COMMERCIAL_POLICY_DEFAULTS.dunning_policy;
  const at = (day: number, extra: Partial<{ provider_halted: boolean; invoiced: boolean }> = {}) => dunningStage(dunning, { day, provider_halted: false, invoiced: false, ...extra });

  it("past due to day 7, restricted to day 14, suspended from day 15, closed from day 45", () => {
    expect([0, 7, 8, 14, 15, 44, 45, 400].map((d) => at(d))).toEqual(["past_due", "past_due", "restricted", "restricted", "suspended", "suspended", "closed", "closed"]);
  });

  it("the provider halting suspends at once, and never reopens a closed account", () => {
    expect(at(3, { provider_halted: true })).toBe("suspended");
    expect(at(50, { provider_halted: true })).toBe("closed");
  });

  it("invoiced accounts are never moved past past due automatically", () => {
    expect(at(30, { invoiced: true })).toBe("past_due");
    expect(at(3, { invoiced: true, provider_halted: true })).toBe("past_due");
  });

  it("counts whole days from the first failed charge", () => {
    const first = new Date("2026-10-01T10:00:00Z");
    expect(dunningDay(first, new Date("2026-10-01T23:00:00Z"))).toBe(0);
    expect(dunningDay(first, new Date("2026-10-09T10:00:00Z"))).toBe(8);
    expect(dunningDay(first, new Date("2026-09-30T10:00:00Z"))).toBe(0);
  });

  it("the schema refuses stages out of order", () => {
    const stages = dunning.stages.map((s) => ({ ...s }));
    stages[2]!.from_day = 5;
    expect(dunningPolicySchema.safeParse({ ...dunning, stages }).success).toBe(false);
  });
});

describe("price book", () => {
  const book = COMMERCIAL_POLICY_DEFAULTS.price_book;

  it("USD is 79 per seat per month on annual billing, plus 20% month to month", () => {
    expect(seatMonthMinor(book, "USD", "annual")).toBe(7900);
    expect(seatMonthMinor(book, "USD", "monthly")).toBe(9480);
    expect(seatMonthMinor(book, "INR", "annual")).toBe(599_900);
  });

  it("has no price for a currency outside the book, so nothing is converted", () => {
    expect(seatMonthMinor(book, "AUD", "annual")).toBeNull();
  });

  it("TCV is seats x per-seat price x term", () => {
    expect(contractValueMinor(10, 7900, 12)).toBe(948_000);
  });
});

describe("proposal terms the approval rules read", () => {
  const base = {
    currency: "USD",
    billing_cadence: "annual",
    term_months: 12,
    discount_pct: 0,
    tax_pct: 0,
    notes: null,
    line_items: [{ position: 1, kind: "seats" as const, description: "Seats", quantity: 10, unit_amount_minor: 7900, discount_pct: 0 }],
    totals: { subtotal_minor: 79_000, discount_minor: 0, tax_minor: 0, total_minor: 79_000 },
  };

  it("left out, they are the standard terms", () => {
    expect(proposalApprovalTerms({})).toEqual({ payment_terms_net_days: 30, free_credits: 0, custom_clauses: false, non_standard_sla: false });
  });

  it("standard terms leave the content hash as it was before COPS-08, so sent versions stay valid", () => {
    expect(proposalContentHash({ ...base, approval_terms: proposalApprovalTerms({}) })).toBe(proposalContentHash(base));
  });

  it("any non-standard term changes the hash", () => {
    const standard = proposalContentHash(base);
    for (const terms of [{ payment_terms_net_days: 60 }, { free_credits: 100 }, { custom_clauses: true }, { non_standard_sla: true }]) {
      expect(proposalContentHash({ ...base, approval_terms: terms })).not.toBe(standard);
    }
  });
});
