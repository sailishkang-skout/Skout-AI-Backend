import { z } from "zod";

/**
 * COPS-08 e-signature rules with no I/O (Bible p.32): the status an envelope reaches from provider
 * events arriving in any order, and which contract template applies to a deal.
 */

/** What a provider can tell us about an envelope. */
export const ENVELOPE_EVENT_STATUSES = ["sent", "viewed", "expired", "declined", "signed"] as const;
export type EnvelopeEventStatus = (typeof ENVELOPE_EVENT_STATUSES)[number];

/** pending_send and failed are ours: the row exists before the provider has accepted the envelope. */
export const ENVELOPE_STATUSES = ["pending_send", "failed", ...ENVELOPE_EVENT_STATUSES] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

/** An envelope that still occupies its contract version: nothing final has happened to it. */
export const LIVE_ENVELOPE_STATUSES: readonly EnvelopeStatus[] = ["pending_send", "sent", "viewed"];

/**
 * One total order, so events applied in any order end in the same status: the highest rank seen.
 * A late "viewed" never undoes "signed", and a signature beats a decline or expiry that reached us
 * first. `failed` is outside the order: a provider event proves the envelope went out after all.
 */
const RANK: Record<EnvelopeStatus, number> = { failed: 0, pending_send: 0, sent: 1, viewed: 2, expired: 3, declined: 4, signed: 5 };

/** The status after an event, or null when the event changes nothing. */
export function nextEnvelopeStatus(current: EnvelopeStatus, incoming: EnvelopeEventStatus): EnvelopeEventStatus | null {
  return RANK[incoming] > RANK[current] ? incoming : null;
}

// --- templates -----------------------------------------------------------------------------------

const matchValue = z.string().trim().min(1).max(64);

/** One entry of the esign_template admin config kind. */
export const esignTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    contract_kind: z.enum(["msa", "order_form", "dpa"]),
    /** The template id at the e-sign provider. */
    provider_template_id: z.string().trim().min(1).max(200),
    /** Every field given must equal the deal's; a field left out matches any deal. */
    match: z.object({ region: matchValue.optional(), segment: matchValue.optional(), legal_entity: matchValue.optional(), deal_type: matchValue.optional() }).strict(),
    active: z.boolean(),
  })
  .strict();
export type EsignTemplate = z.infer<typeof esignTemplateSchema>;

export interface TemplateContext {
  contract_kind: string;
  region?: string | null;
  segment?: string | null;
  legal_entity?: string | null;
  deal_type?: string | null;
}

const MATCH_FIELDS = ["region", "segment", "legal_entity", "deal_type"] as const;

/**
 * The most specific active template for the contract kind: the one that names the most fields, all
 * of them equal to the deal's. Ties go to the lower key, so the choice does not depend on order.
 * Null when nothing matches; the contract then goes out as the uploaded document alone.
 */
export function selectEsignTemplate(templates: Array<{ key: string; value: EsignTemplate }>, context: TemplateContext): { key: string; value: EsignTemplate } | null {
  const same = (a: string, b: string | null | undefined) => b != null && a.trim().toLowerCase() === b.trim().toLowerCase();
  const candidates = templates
    .filter(({ value }) => value.active && value.contract_kind === context.contract_kind)
    .filter(({ value }) => MATCH_FIELDS.every((f) => value.match[f] === undefined || same(value.match[f]!, context[f])))
    .map((t) => ({ t, specificity: MATCH_FIELDS.filter((f) => t.value.match[f] !== undefined).length }));
  candidates.sort((a, b) => b.specificity - a.specificity || a.t.key.localeCompare(b.t.key));
  return candidates[0]?.t ?? null;
}
