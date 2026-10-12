import { createHash } from "node:crypto";
import type { EvidenceFact } from "./research.service.js";

/**
 * ENR-05 — the sequence composer.
 *
 * It proposes a reason to reach out and one or two talking points for each recipient, plus the
 * step copy around them. The rule it is built on: a sentence that states something about a
 * person or a company is a *claim*, and a claim exists only as the wording of one evidence
 * fact. There is no way to add a claim without a fact, so a draft cannot say something the
 * workspace has no source for.
 *
 * A fact that is verified and fresh becomes a usable claim and may appear in copy. A fact seen
 * only on a discovery card, or captured too long ago, becomes a flagged claim: shown to the
 * reviewer with the reason, never placed in copy.
 *
 * The wording is produced by fixed rules, not by a language model, so the same evidence always
 * yields the same sentence and nothing is inferred beyond the fact's own value.
 */

export const COMPOSER_VERSION = "evidence_rules_v1";
export const DRAFT_SCHEMA_VERSION = 1;
/** Replaced per recipient with their opening lines; removed when they have none. */
export const OPENING_TOKEN = "{{opening}}";

export type ClaimKind = "role" | "job_change" | "company";
export type ClaimExclusion = "discovery_only" | "stale" | "unverified";

export interface Claim {
  kind: ClaimKind;
  /** The sentence as it would appear in copy. */
  text: string;
  /** The Evidence Ledger row this sentence words. Always present. */
  evidenceId: string;
  attribute: string;
  source: string;
  sourceUrl: string | null;
  capturedAt: string;
  observedAt: string;
  confidence: number;
  state: EvidenceFact["state"];
  stale: boolean;
  /** Verified and fresh. Only usable claims are placed in copy. */
  usable: boolean;
  excludedReason: ClaimExclusion | null;
  /** Hash of the fact's value: the claim is out of date once the fact changes. */
  valueHash: string;
}

export interface RecipientClaims {
  /** Why reach out to this person now. Null when no usable fact supports a reason. */
  reason: Claim | null;
  /** Company or person facts worth mentioning. Usable claims only. */
  talkingPoints: Claim[];
  /** Facts that could not be used, with the reason, for the reviewer. */
  flagged: Claim[];
  /** The reason and first talking point as they appear in step 1. Empty when there is none. */
  opening: string;
}

export interface DraftStep {
  order: number;
  delayDays: number;
  subject: string;
  body: string;
}

export interface CampaignDraft {
  schemaVersion: number;
  composer: string;
  steps: DraftStep[];
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 32);

/** Captured text is read from a web page: keep it to one plain line before it goes into copy. */
function clean(value: string, max = 120): string {
  const single = value.replace(/[\r\n\t]+/g, " ").replace(/[{}<>]/g, "").replace(/\s+/g, " ").trim();
  return single.length > max ? "" : single;
}

function toClaim(kind: ClaimKind, sentence: string, fact: EvidenceFact): Claim {
  const excludedReason: ClaimExclusion | null = fact.usableForClaims
    ? null
    : fact.state === "discovery"
      ? "discovery_only"
      : fact.state === "verified"
        ? "stale"
        : "unverified";
  return {
    kind,
    text: sentence,
    evidenceId: fact.evidenceId,
    attribute: fact.attribute,
    source: fact.source,
    sourceUrl: fact.sourceUrl,
    capturedAt: fact.capturedAt,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
    state: fact.state,
    stale: fact.stale,
    usable: fact.usableForClaims,
    excludedReason,
    valueHash: hash(fact.value),
  };
}

function roleClaim(fact: EvidenceFact | undefined, jobChange: boolean): Claim | null {
  if (!fact) return null;
  const value = (fact.value ?? {}) as { companyName?: unknown; title?: unknown };
  const company = clean(text(value.companyName));
  const title = clean(text(value.title));
  if (!company) return null;
  if (jobChange) {
    return toClaim("job_change", title ? `I saw that you recently moved into the ${title} role at ${company}.` : `I saw that you recently joined ${company}.`, fact);
  }
  return toClaim("role", title ? `I saw that you're ${title} at ${company}.` : `I saw that you're at ${company}.`, fact);
}

function companyClaims(companyName: string, facts: EvidenceFact[]): Claim[] {
  const name = clean(companyName);
  if (!name) return [];
  const byAttribute = new Map(facts.map((fact) => [fact.attribute, fact]));
  const claims: Claim[] = [];

  const industry = byAttribute.get("industry");
  const industryText = clean(text(industry?.value), 80);
  if (industry && industryText) claims.push(toClaim("company", `${name} is listed under ${industryText}.`, industry));

  const specialties = byAttribute.get("specialties");
  const listed = Array.isArray(specialties?.value) ? specialties.value.map((item) => clean(text(item), 40)).filter(Boolean).slice(0, 2) : [];
  if (specialties && listed.length) claims.push(toClaim("company", `${name} lists ${listed.join(" and ")} among its specialties.`, specialties));

  const size = byAttribute.get("size");
  const sizeText = clean(text(size?.value), 40);
  if (size && sizeText) claims.push(toClaim("company", `${name} lists its size as ${sizeText}.`, size));

  return claims;
}

export interface ComposeInput {
  /** Current facts for the person (ProspectEvidence.facts). */
  personFacts: EvidenceFact[];
  /** Current facts for their employer (AccountEvidence.facts), when the employer is a saved company. */
  companyFacts: EvidenceFact[];
  companyName: string | null;
  /** True when the campaign was suggested by a detected job change. */
  jobChange: boolean;
}

/** Every claim for one recipient. Pure: the same facts always give the same claims. */
export function composeRecipientClaims(input: ComposeInput): RecipientClaims {
  const employment = input.personFacts.find((fact) => fact.attribute === "employment");
  const role = roleClaim(employment, input.jobChange);
  // Company facts are only attached to a person whose employer is itself a verified, fresh fact.
  const company = role?.usable ? companyClaims(input.companyName ?? "", input.companyFacts) : [];

  const reason = role?.usable ? role : null;
  const talkingPoints = company.filter((claim) => claim.usable).slice(0, 2);
  const flagged = [...(role && !role.usable ? [role] : []), ...company.filter((claim) => !claim.usable)];
  const opening = reason ? [reason.text, talkingPoints[0]?.text].filter(Boolean).join(" ") : "";
  return { reason, talkingPoints, flagged, opening };
}

/** The claims that are actually placed in copy. */
export function claimsInCopy(claims: RecipientClaims): Claim[] {
  if (!claims.reason) return [];
  return [claims.reason, ...claims.talkingPoints.slice(0, 1)];
}

/**
 * Starting copy for a new campaign. Step 1 carries the per-recipient opening; the follow-ups
 * state nothing about the recipient. The offer itself is left for the author to write.
 */
export function defaultDraft(jobChange: boolean): CampaignDraft {
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    composer: COMPOSER_VERSION,
    steps: [
      {
        order: 1,
        delayDays: 0,
        subject: jobChange ? "Congratulations on the new role" : "A quick question, {{firstName}}",
        body: `Hi {{firstName}},\n\n${OPENING_TOKEN}\n\n[Write one or two sentences on why you are getting in touch and what you are offering.]\n\nWould it be worth a short conversation?\n\n{{senderName}}`,
      },
      {
        order: 2,
        delayDays: 3,
        subject: "Re: following up",
        body: "Hi {{firstName}},\n\nI wanted to follow up on my note from earlier this week. Is this something worth a short conversation?\n\n{{senderName}}",
      },
      {
        order: 3,
        delayDays: 7,
        subject: "Re: closing the loop",
        body: "Hi {{firstName}},\n\nI won't keep following up. If the timing is better later, I'm glad to pick this up then.\n\n{{senderName}}",
      },
    ],
  };
}

const PLACEHOLDER = /\[[^\]\n]{10,}\]/;

/** Copy problems that block submission. */
export function draftProblems(draft: CampaignDraft): string[] {
  const problems: string[] = [];
  if (!draft.steps?.length) problems.push("The campaign has no steps.");
  for (const step of draft.steps ?? []) {
    if (!step.subject.trim()) problems.push(`Step ${step.order} has no subject.`);
    if (!step.body.trim()) problems.push(`Step ${step.order} has no body.`);
    if (PLACEHOLDER.test(step.body) || PLACEHOLDER.test(step.subject)) problems.push(`Step ${step.order} still contains placeholder text in [brackets].`);
    if (step.order > 1 && step.body.includes(OPENING_TOKEN)) problems.push(`Step ${step.order} uses ${OPENING_TOKEN}; only step 1 may.`);
  }
  return problems;
}

/** Step body for one recipient: the opening goes where the token is, or the token's paragraph is dropped. */
export function renderBody(body: string, opening: string): string {
  if (!body.includes(OPENING_TOKEN)) return body;
  if (opening) return body.split(OPENING_TOKEN).join(opening);
  return body
    .split(OPENING_TOKEN)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What an approval covers for one recipient: who, at which address, and the evidence behind each claim in their copy. */
export function recipientFingerprint(prospectId: string, email: string | null, claims: RecipientClaims): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        prospectId,
        email: (email ?? "").toLowerCase(),
        opening: claims.opening,
        claims: claimsInCopy(claims).map((claim) => ({ evidenceId: claim.evidenceId, valueHash: claim.valueHash, state: claim.state, stale: claim.stale })),
      })
    )
    .digest("hex");
}

/** What an approval covers for the copy. */
export function draftFingerprint(draft: CampaignDraft): string {
  const steps = draft.steps.map(({ order, delayDays, subject, body }) => ({ order, delayDays, subject, body }));
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
}
