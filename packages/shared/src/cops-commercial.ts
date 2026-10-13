/**
 * COPS-03 — commercial rules with no I/O: proposal totals, the canonical content hash that makes a
 * sent version tamper-evident, the provisioning gate rule, and payment status progression.
 * Money is integer minor units; BigInt is used internally so large quantities cannot lose precision.
 */
import { createHash } from "node:crypto";

export const COMMERCIAL_LINE_KINDS = ["product", "seats", "credits", "fee"] as const;

/** COPS-08: what one line amount covers - one month, the whole term, or a single charge. */
export const PRICE_BASES = ["per_month", "per_term", "one_time"] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];
/** Lines written before COPS-08 carry no basis: a fee is charged once, anything else covers the term. */
export function defaultPriceBasis(kind: string): PriceBasis {
  return kind === "fee" ? "one_time" : "per_term";
}
export type CommercialLineKind = (typeof COMMERCIAL_LINE_KINDS)[number];

export const BILLING_CADENCES = ["one_time", "monthly", "quarterly", "annual"] as const;
export type BillingCadence = (typeof BILLING_CADENCES)[number];

export interface ProposalLineInput {
  kind: CommercialLineKind;
  description: string;
  quantity: number;
  unit_amount_minor: number;
  discount_pct?: number;
  price_basis?: PriceBasis;
}

export interface ProposalTermsInput {
  currency: string;
  billing_cadence: BillingCadence;
  term_months: number;
  discount_pct?: number;
  tax_pct?: number;
  notes?: string | null;
  /** COPS-08 terms the approval rules read. Left out, they take the standard values. */
  payment_terms_net_days?: number;
  free_credits?: number;
  custom_clauses?: boolean;
  non_standard_sla?: boolean;
  line_items: ProposalLineInput[];
}

/** Standard terms: net 30, no complimentary credits, no custom clauses, standard SLA. */
export const STANDARD_PROPOSAL_TERMS = { payment_terms_net_days: 30, free_credits: 0, custom_clauses: false, non_standard_sla: false } as const;
export type ProposalApprovalTerms = { -readonly [K in keyof typeof STANDARD_PROPOSAL_TERMS]: (typeof STANDARD_PROPOSAL_TERMS)[K] extends number ? number : boolean };

export function proposalApprovalTerms(terms: Partial<ProposalApprovalTerms>): ProposalApprovalTerms {
  return {
    payment_terms_net_days: terms.payment_terms_net_days ?? STANDARD_PROPOSAL_TERMS.payment_terms_net_days,
    free_credits: terms.free_credits ?? STANDARD_PROPOSAL_TERMS.free_credits,
    custom_clauses: terms.custom_clauses ?? STANDARD_PROPOSAL_TERMS.custom_clauses,
    non_standard_sla: terms.non_standard_sla ?? STANDARD_PROPOSAL_TERMS.non_standard_sla,
  };
}

export interface ComputedLine extends ProposalLineInput {
  position: number;
  discount_pct: number;
  gross_minor: number;
  discount_minor: number;
  net_minor: number;
}

export interface ProposalTotals {
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
}

/** Percent (up to 2 decimals) to basis points. 12.5% -> 1250. */
function toBasisPoints(pct: number | undefined): bigint {
  const value = pct ?? 0;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("Percent must be between 0 and 100");
  }
  return BigInt(Math.round(value * 100));
}

/** amount × bp / 10000, rounded half-up. Inputs are non-negative. */
function applyBasisPoints(amount: bigint, bp: bigint): bigint {
  return (amount * bp + 5000n) / 10000n;
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Amount exceeds the supported range");
  return Number(value);
}

/**
 * Totals for one proposal version. Order: line gross, line discount, subtotal (sum of gross),
 * header discount on the amount left after line discounts, then tax on the discounted amount.
 */
export function computeProposalTotals(terms: Pick<ProposalTermsInput, "line_items" | "discount_pct" | "tax_pct">): {
  lines: ComputedLine[];
  totals: ProposalTotals;
} {
  let subtotal = 0n;
  let lineDiscounts = 0n;
  const lines = terms.line_items.map((line, index) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new RangeError("Quantity must be a positive integer");
    if (!Number.isInteger(line.unit_amount_minor) || line.unit_amount_minor < 0) {
      throw new RangeError("Unit amount must be a non-negative integer");
    }
    const gross = BigInt(line.quantity) * BigInt(line.unit_amount_minor);
    const discount = applyBasisPoints(gross, toBasisPoints(line.discount_pct));
    subtotal += gross;
    lineDiscounts += discount;
    return {
      ...line,
      position: index + 1,
      discount_pct: line.discount_pct ?? 0,
      gross_minor: toSafeNumber(gross),
      discount_minor: toSafeNumber(discount),
      net_minor: toSafeNumber(gross - discount),
    };
  });
  const afterLineDiscounts = subtotal - lineDiscounts;
  const headerDiscount = applyBasisPoints(afterLineDiscounts, toBasisPoints(terms.discount_pct));
  const taxable = afterLineDiscounts - headerDiscount;
  const tax = applyBasisPoints(taxable, toBasisPoints(terms.tax_pct));
  return {
    lines,
    totals: {
      subtotal_minor: toSafeNumber(subtotal),
      discount_minor: toSafeNumber(lineDiscounts + headerDiscount),
      tax_minor: toSafeNumber(tax),
      total_minor: toSafeNumber(taxable + tax),
    },
  };
}

/** JSON with object keys sorted at every level, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash of everything a customer sees in a proposal version. Stored at send, recomputed on read. */
export function proposalContentHash(input: {
  currency: string;
  billing_cadence: string;
  term_months: number;
  discount_pct: number;
  tax_pct: number;
  notes: string | null;
  line_items: Array<Pick<ComputedLine, "position" | "kind" | "description" | "quantity" | "unit_amount_minor" | "discount_pct" | "price_basis">>;
  totals: ProposalTotals;
  approval_terms?: Partial<ProposalApprovalTerms>;
}): string {
  // Only non-standard terms enter the hash, so versions sent before COPS-08 keep a valid hash.
  const extra = proposalApprovalTerms(input.approval_terms ?? {});
  const nonStandard = (Object.keys(STANDARD_PROPOSAL_TERMS) as Array<keyof ProposalApprovalTerms>).some((k) => extra[k] !== STANDARD_PROPOSAL_TERMS[k]);
  return sha256Hex(
    canonicalJson({
      currency: input.currency,
      billing_cadence: input.billing_cadence,
      term_months: input.term_months,
      discount_pct: Number(input.discount_pct),
      tax_pct: Number(input.tax_pct),
      notes: input.notes ?? null,
      line_items: [...input.line_items]
        .sort((a, b) => a.position - b.position)
        .map((l) => ({
          position: l.position,
          kind: l.kind,
          description: l.description,
          quantity: Number(l.quantity),
          unit_amount_minor: Number(l.unit_amount_minor),
          discount_pct: Number(l.discount_pct),
          // Only a non-default basis enters the hash, so versions sent before COPS-08 stay valid.
          ...(l.price_basis && l.price_basis !== defaultPriceBasis(l.kind) ? { price_basis: l.price_basis } : {}),
        })),
      totals: input.totals,
      ...(nonStandard ? { approval_terms: extra } : {}),
    })
  );
}

// ---- Provisioning gate (Bible p.35) ----

export const COMMERCIAL_GATE_POLICIES = [
  "trial_approval_only",
  "signature",
  "payment",
  "signature+payment",
  "manual_override",
] as const;
export type CommercialGatePolicy = (typeof COMMERCIAL_GATE_POLICIES)[number];

/** Used when neither the deal type nor the workspace default has a policy (strictest, see audit Q3). */
export const SYSTEM_DEFAULT_GATE_POLICY: CommercialGatePolicy = "signature+payment";

export interface GateConditions {
  trial_approved: boolean;
  signature_complete: boolean;
  payment_complete: boolean;
  overridden: boolean;
  /** COPS-08: false while a live proposal of the opportunity is over a threshold and not approved. */
  approvals_complete?: boolean;
}

/**
 * True when the policy's conditions are met. An override opens any policy. Missing approvals keep
 * every other policy closed: a signature or payment does not provision an unapproved deal.
 */
export function isGateOpen(policy: CommercialGatePolicy, c: GateConditions): boolean {
  if (c.overridden) return true;
  if (c.approvals_complete === false) return false;
  switch (policy) {
    case "trial_approval_only":
      return c.trial_approved;
    case "signature":
      return c.signature_complete;
    case "payment":
      return c.payment_complete;
    case "signature+payment":
      return c.signature_complete && c.payment_complete;
    case "manual_override":
      return false;
  }
}

// ---- Payment request status (webhook-derived) ----

export const PAYMENT_REQUEST_STATUSES = ["requested", "paid", "failed", "expired", "cancelled", "refunded"] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

const PAYMENT_FORWARD: Record<PaymentRequestStatus, readonly PaymentRequestStatus[]> = {
  requested: ["paid", "failed", "expired", "cancelled"],
  // A failed attempt can still be paid on the same link, or the link can lapse.
  failed: ["paid", "expired", "cancelled"],
  paid: ["refunded"],
  expired: [],
  cancelled: [],
  refunded: [],
};

/** The status after an incoming provider status, or null when it must be ignored (late or repeated). */
export function nextPaymentStatus(current: PaymentRequestStatus, incoming: PaymentRequestStatus): PaymentRequestStatus | null {
  return PAYMENT_FORWARD[current].includes(incoming) ? incoming : null;
}

// ---- Total contract value (COPS-08) ----

/**
 * TCV = recurring lines x term in months + whole-term lines + one-time fees, after line and header
 * discounts, before tax. Every line is first brought to the full term, so ten seats at 79 a month
 * for 12 months and ten seats at 948 for the term give the same TCV. `discount_pct` is the
 * effective discount on that basis: line and header discounts together.
 */
export function proposalTcv(input: {
  term_months: number;
  discount_pct: number;
  lines: Array<{ kind: string; price_basis?: PriceBasis | string | null; gross_minor: number; net_minor: number }>;
}): { gross_minor: number; tcv_minor: number; discount_pct: number } {
  let gross = 0;
  let afterLineDiscounts = 0;
  for (const line of input.lines) {
    const months = (line.price_basis ?? defaultPriceBasis(line.kind)) === "per_month" ? input.term_months : 1;
    gross += line.gross_minor * months;
    afterLineDiscounts += line.net_minor * months;
  }
  const tcv = afterLineDiscounts - Math.round((afterLineDiscounts * input.discount_pct) / 100);
  return { gross_minor: gross, tcv_minor: tcv, discount_pct: gross > 0 ? Math.round(((gross - tcv) * 10_000) / gross) / 100 : 0 };
}
