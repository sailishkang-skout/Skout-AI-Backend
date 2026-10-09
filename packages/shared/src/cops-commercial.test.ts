import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeProposalTotals,
  isGateOpen,
  nextPaymentStatus,
  proposalContentHash,
  type GateConditions,
} from "./cops-commercial.js";

describe("computeProposalTotals", () => {
  it("sums gross, applies line then header discount, then tax", () => {
    const { lines, totals } = computeProposalTotals({
      line_items: [
        { kind: "seats", description: "Seats", quantity: 10, unit_amount_minor: 1_000_00, discount_pct: 10 },
        { kind: "fee", description: "Onboarding", quantity: 1, unit_amount_minor: 500_00 },
      ],
      discount_pct: 5,
      tax_pct: 18,
    });
    // gross 10000_00 + 500_00 = 10500_00; line discount 1000_00; after = 9500_00
    // header 5% = 475_00; taxable 9025_00; tax 18% = 1624_50; total 10649_50
    expect(lines[0]).toMatchObject({ position: 1, gross_minor: 1_000_000, discount_minor: 100_000, net_minor: 900_000 });
    expect(lines[1]).toMatchObject({ position: 2, discount_pct: 0, net_minor: 50_000 });
    expect(totals).toEqual({ subtotal_minor: 1_050_000, discount_minor: 147_500, tax_minor: 162_450, total_minor: 1_064_950 });
  });

  it("rounds half-up to a minor unit", () => {
    // 1 × 333 at 12.5% discount = 41.625 -> 42
    const { totals } = computeProposalTotals({
      line_items: [{ kind: "product", description: "x", quantity: 1, unit_amount_minor: 333, discount_pct: 12.5 }],
    });
    expect(totals).toEqual({ subtotal_minor: 333, discount_minor: 42, tax_minor: 0, total_minor: 291 });
  });

  it("handles a zero-priced line and 100% discount", () => {
    const { totals } = computeProposalTotals({
      line_items: [
        { kind: "credits", description: "Bonus credits", quantity: 500, unit_amount_minor: 0 },
        { kind: "product", description: "Comped", quantity: 1, unit_amount_minor: 9_999, discount_pct: 100 },
      ],
      tax_pct: 18,
    });
    expect(totals).toEqual({ subtotal_minor: 9_999, discount_minor: 9_999, tax_minor: 0, total_minor: 0 });
  });

  it("keeps precision for large quantities", () => {
    const { totals } = computeProposalTotals({
      line_items: [{ kind: "credits", description: "Credits", quantity: 1_000_000, unit_amount_minor: 1_000_000 }],
    });
    expect(totals.total_minor).toBe(1_000_000_000_000);
  });

  it("rejects invalid input", () => {
    expect(() => computeProposalTotals({ line_items: [{ kind: "fee", description: "x", quantity: 0, unit_amount_minor: 1 }] })).toThrow();
    expect(() => computeProposalTotals({ line_items: [{ kind: "fee", description: "x", quantity: 1, unit_amount_minor: -1 }] })).toThrow();
    expect(() => computeProposalTotals({ line_items: [{ kind: "fee", description: "x", quantity: 1, unit_amount_minor: 1, discount_pct: 101 }] })).toThrow();
    expect(() => computeProposalTotals({ line_items: [{ kind: "fee", description: "x", quantity: 1, unit_amount_minor: 1 }], tax_pct: -1 })).toThrow();
  });
});

describe("proposalContentHash", () => {
  const base = {
    currency: "INR",
    billing_cadence: "annual",
    term_months: 12,
    discount_pct: 0,
    tax_pct: 18,
    notes: null,
    line_items: [
      { position: 2, kind: "fee" as const, description: "B", quantity: 1, unit_amount_minor: 200, discount_pct: 0 },
      { position: 1, kind: "seats" as const, description: "A", quantity: 2, unit_amount_minor: 100, discount_pct: 0 },
    ],
    totals: { subtotal_minor: 400, discount_minor: 0, tax_minor: 72, total_minor: 472 },
  };

  it("is stable regardless of line order and key order", () => {
    const reordered = { ...base, line_items: [...base.line_items].reverse() };
    expect(proposalContentHash(reordered)).toBe(proposalContentHash(base));
    expect(proposalContentHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when any customer-visible value changes", () => {
    const h = proposalContentHash(base);
    expect(proposalContentHash({ ...base, tax_pct: 12 })).not.toBe(h);
    expect(proposalContentHash({ ...base, notes: "x" })).not.toBe(h);
    const lines = base.line_items.map((l) => (l.position === 1 ? { ...l, unit_amount_minor: 101 } : l));
    expect(proposalContentHash({ ...base, line_items: lines })).not.toBe(h);
  });

  it("canonicalJson sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

describe("isGateOpen", () => {
  const none: GateConditions = { trial_approved: false, signature_complete: false, payment_complete: false, overridden: false };

  it("applies each policy", () => {
    expect(isGateOpen("trial_approval_only", { ...none, trial_approved: true })).toBe(true);
    expect(isGateOpen("signature", { ...none, signature_complete: true })).toBe(true);
    expect(isGateOpen("payment", { ...none, payment_complete: true })).toBe(true);
    expect(isGateOpen("signature+payment", { ...none, signature_complete: true })).toBe(false);
    expect(isGateOpen("signature+payment", { ...none, signature_complete: true, payment_complete: true })).toBe(true);
    expect(isGateOpen("manual_override", { ...none, signature_complete: true, payment_complete: true, trial_approved: true })).toBe(false);
  });

  it("opens any policy on override", () => {
    for (const p of ["trial_approval_only", "signature", "payment", "signature+payment", "manual_override"] as const) {
      expect(isGateOpen(p, { ...none, overridden: true })).toBe(true);
      expect(isGateOpen(p, none)).toBe(false);
    }
  });
});

describe("nextPaymentStatus", () => {
  it("moves forward only", () => {
    expect(nextPaymentStatus("requested", "paid")).toBe("paid");
    expect(nextPaymentStatus("failed", "paid")).toBe("paid");
    expect(nextPaymentStatus("paid", "refunded")).toBe("refunded");
    expect(nextPaymentStatus("paid", "failed")).toBeNull();
    expect(nextPaymentStatus("paid", "paid")).toBeNull();
    expect(nextPaymentStatus("refunded", "paid")).toBeNull();
    expect(nextPaymentStatus("expired", "paid")).toBeNull();
  });
});
