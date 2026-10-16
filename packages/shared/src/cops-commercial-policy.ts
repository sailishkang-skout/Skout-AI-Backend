import { z } from "zod";
import { COMMERCIAL_POLICY_DEFAULT_DATA } from "./cops-commercial-policy.default.js";

/**
 * COPS-08 commercial policy (Bible p.34-37): approval thresholds, the failed-payment timeline and
 * the price book. The numbers live in the versioned admin config (kinds approval_policy,
 * dunning_policy, price_book), seeded from docs/ops/cops-commercial-policy.default.json. The
 * functions here are pure and take the policy as an argument; none of them contains a threshold.
 */
export const APPROVER_ROLES = ["sales_manager", "finance", "legal_revops", "executive"] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

/**
 * Who may decide each approver slot. There is no Executive workspace role; a workspace Admin
 * decides the executive slot (Aditya, 2026-10-13). The other slots are the role of the same name.
 */
export const APPROVER_DECIDED_BY: Record<ApproverRole, "sales_manager" | "finance" | "legal_revops" | "admin"> = {
  sales_manager: "sales_manager",
  finance: "finance",
  legal_revops: "legal_revops",
  executive: "admin",
};

const approvers = z.array(z.enum(APPROVER_ROLES)).min(1).max(APPROVER_ROLES.length);
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Three-letter currency code");

/** A band matches a value that is over `over` and at most `up_to` (null: no upper limit). */
const band = z
  .object({ over: z.number().min(0), up_to: z.number().positive().nullable(), approvers })
  .strict()
  .refine((b) => b.up_to == null || b.up_to > b.over, { message: "up_to must be greater than over", path: ["up_to"] });

const bands = z
  .array(band)
  .max(10)
  .superRefine((list, ctx) => {
    list.forEach((b, i) => {
      const prev = list[i - 1];
      if (!prev) return;
      if (prev.up_to == null) ctx.addIssue({ code: "custom", message: "Only the last band may have no upper limit", path: [i - 1, "up_to"] });
      else if (b.over < prev.up_to) ctx.addIssue({ code: "custom", message: "Bands must ascend without overlapping", path: [i, "over"] });
    });
  });

const flagRule = z.object({ approvers }).strict();

export const approvalPolicySchema = z
  .object({
    /** A granted approval lapses this many days after the request was made. */
    expires_after_days: z.number().int().min(1).max(365),
    discount_pct: bands,
    seats: bands,
    /** Per currency, in minor units. A currency with null or no entry cannot be evaluated. */
    contract_value_minor: z.record(currencyCode, bands.nullable()),
    term_months: bands,
    /** null switches the rule off. */
    free_credits: bands.nullable(),
    payment_terms_net_days: bands,
    custom_clauses: flagRule.nullable(),
    non_standard_sla: flagRule.nullable(),
  })
  .strict();
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const APPROVAL_RULES = ["discount_pct", "seats", "contract_value", "term_months", "free_credits", "payment_terms", "custom_clauses", "non_standard_sla"] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];

/** The terms of one proposal version that the approval rules read. */
export interface ApprovalTerms {
  currency: string;
  discount_pct: number;
  seats: number;
  contract_value_minor: number;
  term_months: number;
  free_credits: number;
  payment_terms_net_days: number;
  custom_clauses: boolean;
  non_standard_sla: boolean;
}

export interface ApprovalEvaluation {
  /** Union of the approvers every matching rule names, in APPROVER_ROLES order. Empty: no approval step. */
  required_approvers: ApproverRole[];
  matched_rules: Array<{ rule: ApprovalRule; value: number | null; approvers: ApproverRole[] }>;
  /** Rules with nothing configured to evaluate against, for example contract value in a currency with no thresholds. */
  unevaluated: ApprovalRule[];
}

type Bands = z.infer<typeof bands>;
const matchBand = (list: Bands, value: number) => list.find((b) => value > b.over && (b.up_to == null || value <= b.up_to));

/** Every matching rule applies and the deal needs every approver named by any of them. */
export function evaluateApprovals(policy: ApprovalPolicy, terms: ApprovalTerms): ApprovalEvaluation {
  const matched: ApprovalEvaluation["matched_rules"] = [];
  const unevaluated: ApprovalRule[] = [];
  const banded = (rule: ApprovalRule, list: Bands, value: number) => {
    const hit = matchBand(list, value);
    if (hit) matched.push({ rule, value, approvers: hit.approvers });
  };

  banded("discount_pct", policy.discount_pct, terms.discount_pct);
  banded("seats", policy.seats, terms.seats);
  const valueBands = policy.contract_value_minor[terms.currency];
  if (valueBands) banded("contract_value", valueBands, terms.contract_value_minor);
  else unevaluated.push("contract_value");
  banded("term_months", policy.term_months, terms.term_months);
  if (policy.free_credits) banded("free_credits", policy.free_credits, terms.free_credits);
  banded("payment_terms", policy.payment_terms_net_days, terms.payment_terms_net_days);
  if (terms.custom_clauses && policy.custom_clauses) matched.push({ rule: "custom_clauses", value: null, approvers: policy.custom_clauses.approvers });
  if (terms.non_standard_sla && policy.non_standard_sla) matched.push({ rule: "non_standard_sla", value: null, approvers: policy.non_standard_sla.approvers });

  const needed = new Set(matched.flatMap((m) => m.approvers));
  return { required_approvers: APPROVER_ROLES.filter((r) => needed.has(r)), matched_rules: matched, unevaluated };
}

/**
 * A change to any of these voids approvals already given. Title and notes are not material.
 * `line_items_key` is any stable digest of the line items, so a re-mix at the same total still counts.
 */
export interface MaterialTerms extends ApprovalTerms {
  billing_cadence: string;
  line_items_key: string;
}
const MATERIAL_FIELDS = [
  "currency",
  "discount_pct",
  "seats",
  "contract_value_minor",
  "term_months",
  "free_credits",
  "payment_terms_net_days",
  "custom_clauses",
  "non_standard_sla",
  "billing_cadence",
  "line_items_key",
] as const satisfies ReadonlyArray<keyof MaterialTerms>;

export function materialChanges(before: MaterialTerms, after: MaterialTerms): Array<keyof MaterialTerms> {
  return MATERIAL_FIELDS.filter((f) => before[f] !== after[f]);
}

// --- failed payment timeline ---------------------------------------------------------------------

export const DUNNING_STATES = ["past_due", "restricted", "suspended", "closed"] as const;
export type DunningState = (typeof DUNNING_STATES)[number];

export const dunningPolicySchema = z
  .object({
    /** Day 0 is the first failed charge. Each stage runs from its day until the next stage starts. */
    stages: z
      .array(z.object({ state: z.enum(DUNNING_STATES), from_day: z.number().int().min(0).max(3650) }).strict())
      .length(DUNNING_STATES.length)
      .superRefine((list, ctx) => {
        list.forEach((s, i) => {
          if (s.state !== DUNNING_STATES[i]) ctx.addIssue({ code: "custom", message: `Stage ${i + 1} must be ${DUNNING_STATES[i]}`, path: [i, "state"] });
          if (i === 0 ? s.from_day !== 0 : s.from_day <= list[i - 1]!.from_day) {
            ctx.addIssue({ code: "custom", message: i === 0 ? "The first stage starts on day 0" : "Stages must start on later days in order", path: [i, "from_day"] });
          }
        });
      }),
    /** The provider giving up on retries suspends the workspace at once, whatever the day. */
    suspend_when_provider_halted: z.boolean(),
    /** false: invoiced accounts stay past due until Finance acts. */
    invoiced_accounts_auto_suspend: z.boolean(),
  })
  .strict();
export type DunningPolicy = z.infer<typeof dunningPolicySchema>;

/** Whole days since the first failed charge. */
export function dunningDay(firstFailedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - firstFailedAt.getTime()) / 86_400_000));
}

export function dunningStage(policy: DunningPolicy, input: { day: number; provider_halted: boolean; invoiced: boolean }): DunningState {
  if (input.invoiced && !policy.invoiced_accounts_auto_suspend) return "past_due";
  const byDay = [...policy.stages].reverse().find((s) => input.day >= s.from_day)?.state ?? "past_due";
  const rank = (s: DunningState) => DUNNING_STATES.indexOf(s);
  return input.provider_halted && policy.suspend_when_provider_halted && rank(byDay) < rank("suspended") ? "suspended" : byDay;
}

// --- price book ----------------------------------------------------------------------------------

export const priceBookSchema = z
  .object({
    /** Added to the annual per-seat price when the customer pays month to month. */
    month_to_month_surcharge_pct: z.number().min(0).max(100),
    /** One entry per currency. Prices are never converted between currencies. */
    currencies: z.record(
      currencyCode,
      z
        .object({
          seat_month_annual_minor: z.number().int().positive(),
          /** benchmarked and suggested are starting points; Finance marks a price confirmed. */
          status: z.enum(["benchmarked", "suggested", "confirmed"]),
        })
        .strict()
    ),
  })
  .strict();
export type PriceBook = z.infer<typeof priceBookSchema>;

/** Per seat, per month, in minor units; null when the currency has no price. */
export function seatMonthMinor(book: PriceBook, currency: string, billing: "annual" | "monthly"): number | null {
  const entry = book.currencies[currency];
  if (!entry) return null;
  return billing === "annual" ? entry.seat_month_annual_minor : Math.round((entry.seat_month_annual_minor * (100 + book.month_to_month_surcharge_pct)) / 100);
}

/** TCV = seats x per-seat price x term. */
export function contractValueMinor(seats: number, seatMonthPriceMinor: number, termMonths: number): number {
  return seats * seatMonthPriceMinor * termMonths;
}

// --- currency --------------------------------------------------------------------------------------

export const currencyPolicySchema = z
  .object({
    supported: z.array(currencyCode).min(1).max(30),
    /** ISO 3166-1 alpha-2 country to the currency a new account in that country starts with. */
    default_by_country: z.record(z.string().regex(/^[A-Z]{2}$/, "Two-letter country code"), currencyCode),
    fallback: currencyCode,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.supported.includes(v.fallback)) ctx.addIssue({ code: "custom", message: "The fallback currency must be supported", path: ["fallback"] });
    for (const [country, currency] of Object.entries(v.default_by_country)) {
      if (!v.supported.includes(currency)) ctx.addIssue({ code: "custom", message: `${currency} is not a supported currency`, path: ["default_by_country", country] });
    }
  });
export type CurrencyPolicy = z.infer<typeof currencyPolicySchema>;

/** The currency a new account starts with. There is no conversion: this only picks the price book. */
export function defaultCurrencyFor(policy: CurrencyPolicy, country: string | null | undefined): string {
  return (country && policy.default_by_country[country.toUpperCase()]) || policy.fallback;
}

// --- renewals --------------------------------------------------------------------------------------

export const renewalPolicySchema = z
  .object({
    /** A renewal opportunity is opened this many days before the end of a term. */
    lead_days: z.number().int().min(1).max(365),
  })
  .strict();
export type RenewalPolicy = z.infer<typeof renewalPolicySchema>;

/**
 * The seed values, validated when this module loads: a bad edit to the policy file stops the build
 * and the app instead of quietly changing who approves what. Generated from the policy file by
 * scripts/sync-cops-commercial-policy.mjs.
 */
export const COMMERCIAL_POLICY_DEFAULTS = {
  currency_policy: currencyPolicySchema.parse(COMMERCIAL_POLICY_DEFAULT_DATA.currency_policy),
  renewal_policy: renewalPolicySchema.parse(COMMERCIAL_POLICY_DEFAULT_DATA.renewal_policy),
  approval_policy: approvalPolicySchema.parse(COMMERCIAL_POLICY_DEFAULT_DATA.approval_policy),
  dunning_policy: dunningPolicySchema.parse(COMMERCIAL_POLICY_DEFAULT_DATA.dunning_policy),
  price_book: priceBookSchema.parse(COMMERCIAL_POLICY_DEFAULT_DATA.price_book),
};
