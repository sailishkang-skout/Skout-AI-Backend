import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { recordPrivilegedAction } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../../config/env.js";
import { canContact, CAN_CONTACT_MESSAGE, type CanContactBlock } from "../cops-can-contact.js";
import { buildConsentService } from "../consent.service.js";
import { gateEnrollConsent } from "../consent-enroll.service.js";
import { recordEvidence } from "../evidence.service.js";
import { buildSequenceService } from "../sequence.service.js";
import { addSuppression } from "../suppression.service.js";
import { addAudienceOutcome, audienceMembers, getAudienceRow, MAX_AUDIENCE_SIZE, prospectsExist, type AudienceFilters } from "./audience.service.js";
import {
  claimsInCopy,
  COMPOSER_VERSION,
  composeRecipientClaims,
  defaultDraft,
  draftFingerprint,
  draftProblems,
  DRAFT_SCHEMA_VERSION,
  OPENING_TOKEN,
  recipientFingerprint,
  renderBody,
  type CampaignDraft,
  type DraftStep,
  type RecipientClaims,
} from "./campaign-composer.js";
import { CaptureError, type CaptureActor } from "./capture-ingest.service.js";
import { getContactData } from "./contact-data.service.js";
import { getAccountEvidence, getProspectEvidence } from "./research.service.js";

/**
 * ENR-05 — evidence-to-sequence campaigns: build, review, approve, launch, measure.
 *
 * The order is fixed and enforced here, not in the UI:
 *   draft → pending_review → approved → launched
 * Nothing is enrolled before a person with the send permission has approved the recipients and
 * the copy, and that approval is recorded with a fingerprint of exactly what was approved: the
 * copy, each included recipient and address, and the evidence behind every claim. If any of
 * that is different at launch or at send time, the approval no longer applies and the campaign
 * goes back for review.
 *
 * Sending is never done here. Launch creates an ordinary sequence and enrolls the approved
 * recipients through the existing enroll path; the sequence worker sends. Before each send the
 * worker asks `campaignSendGate` whether the approval still stands.
 */

const log = createLogger("enrichment.campaign");
const {
  aiDrafts,
  emailVerifications,
  enrichmentCampaignRecipients,
  enrichmentCampaignReviews,
  enrichmentCampaigns,
  enrichmentChangeEvents,
  prospectActivations,
  sequenceEnrollmentSteps,
  sequenceSteps,
  suppressions,
} = schema;

type CampaignRow = typeof enrichmentCampaigns.$inferSelect;
type RecipientRow = typeof enrichmentCampaignRecipients.$inferSelect;

export type CampaignStatus = "draft" | "pending_review" | "approved" | "rejected" | "changes_required" | "launched" | "dismissed";
export type ExclusionReason = "no_email" | "email_not_verified" | "consent_missing" | "person_removed" | CanContactBlock;

export const EXCLUSION_MESSAGE: Record<ExclusionReason, string> = {
  ...CAN_CONTACT_MESSAGE,
  no_email: "No email address on record",
  email_not_verified: "The email has not been verified as valid",
  consent_missing: "No email consent is recorded and no lawful basis was given at approval",
  person_removed: "This person is no longer in the workspace",
};

/** Statuses in which copy and recipients may still be changed. */
const EDITABLE: CampaignStatus[] = ["draft", "pending_review", "approved", "rejected", "changes_required"];
const SEND_PERMISSION = "sequences:send";
export { SEND_PERMISSION as CAMPAIGN_APPROVE_PERMISSION };

// ── Sandbox ──────────────────────────────────────────────────────────────────

function sandboxAllowList(config: Pick<Env, "ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS">): string[] {
  return (config.ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Outside production a campaign email goes only to an address (or `@domain`) on the sandbox
 * allow-list. With no list configured, nothing is sent outside production.
 */
export function sandboxPolicy(config: Pick<Env, "NODE_ENV" | "ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS">) {
  const active = config.NODE_ENV !== "production";
  const allowed = sandboxAllowList(config);
  return {
    active,
    allowed,
    allows(email: string): boolean {
      if (!active) return true;
      const address = email.trim().toLowerCase();
      const domain = address.slice(address.lastIndexOf("@"));
      return allowed.includes(address) || allowed.includes(domain);
    },
  };
}

// ── Recipient evaluation ─────────────────────────────────────────────────────

interface RecipientState {
  prospectId: string;
  fullName: string | null;
  email: string | null;
  emailVerification: string;
  consentStatus: "active" | "missing";
  eligibility: "eligible" | "excluded";
  exclusionReason: ExclusionReason | null;
  claims: RecipientClaims;
}

const EMPTY_CLAIMS: RecipientClaims = { reason: null, talkingPoints: [], flagged: [], opening: "" };

/**
 * Everything known about one recipient right now: whether they may be contacted (through the
 * central can-contact gate), and the claims the current evidence supports.
 */
async function evaluateRecipient(db: Db, config: Env, workspaceId: string, prospectId: string, jobChange: boolean): Promise<RecipientState> {
  const evidence = await getProspectEvidence(db, workspaceId, prospectId);
  if (!evidence) {
    return { prospectId, fullName: null, email: null, emailVerification: "unverified", consentStatus: "missing", eligibility: "excluded", exclusionReason: "person_removed", claims: EMPTY_CLAIMS };
  }
  const companyId = evidence.employment?.companyId ?? null;
  const [contactData, account, consentActive, [activation]] = await Promise.all([
    getContactData(db, workspaceId, prospectId),
    companyId ? getAccountEvidence(db, workspaceId, companyId) : Promise.resolve(null),
    buildConsentService(db)!.hasActive(workspaceId, "prospect", prospectId, "email"),
    db
      .select({ fullName: sql<string | null>`${prospectActivations.snapshot}->>'fullName'` })
      .from(prospectActivations)
      .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)))
      .limit(1),
  ]);

  const email = contactData?.email?.value.toLowerCase() ?? null;
  const emailVerification = contactData?.email?.verification.status ?? "unverified";
  let exclusionReason: ExclusionReason | null = null;
  if (!email) exclusionReason = "no_email";
  // Only an address the verification service confirmed may be enrolled.
  else if (emailVerification !== "valid") exclusionReason = "email_not_verified";
  else {
    // Suppression list, do-not-contact channel, hard bounce and send eligibility. Consent is
    // tracked separately because the approver can record a lawful basis for it.
    const gate = await canContact(db, config, { workspaceId, email, contactId: evidence.contactId, purpose: "outreach" });
    if (!gate.allowed) exclusionReason = gate.reason;
  }

  return {
    prospectId,
    fullName: activation?.fullName ?? null,
    email,
    emailVerification,
    consentStatus: consentActive ? "active" : "missing",
    eligibility: exclusionReason ? "excluded" : "eligible",
    exclusionReason,
    claims: composeRecipientClaims({
      personFacts: evidence.facts,
      companyFacts: account?.facts ?? [],
      companyName: evidence.employment?.companyName ?? account?.name ?? null,
      jobChange,
    }),
  };
}

async function evaluateAll(db: Db, config: Env, workspaceId: string, prospectIds: string[], jobChange: boolean): Promise<RecipientState[]> {
  const states: RecipientState[] = [];
  const queue = [...prospectIds];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      states.push(await evaluateRecipient(db, config, workspaceId, id, jobChange));
    }
  });
  await Promise.all(workers);
  return states;
}

const draftOf = (row: CampaignRow): CampaignDraft => {
  const draft = row.draft as Partial<CampaignDraft> | null;
  return draft?.steps?.length ? (draft as CampaignDraft) : defaultDraft(row.trigger === "job_change");
};

const fingerprintOf = (recipient: Pick<RecipientRow, "prospectId" | "email" | "claims">) =>
  recipientFingerprint(recipient.prospectId, recipient.email, recipient.claims as RecipientClaims);

/**
 * True when something an approval covered is no longer what was approved: the copy, or — for a
 * recipient who can still be contacted — their address or the evidence behind their claims.
 * A recipient who has since become uncontactable is not a change to review; they are left out.
 */
function approvalIsStale(row: CampaignRow, recipients: RecipientRow[]): boolean {
  if (row.approvedFingerprint !== draftFingerprint(draftOf(row))) return true;
  return recipients.some(
    (recipient) =>
      recipient.approvedFingerprint !== null &&
      !recipient.enrollmentId &&
      recipient.decision === "included" &&
      recipient.eligibility === "eligible" &&
      recipient.approvedFingerprint !== fingerprintOf(recipient)
  );
}

// ── Read ─────────────────────────────────────────────────────────────────────

function toRecipientDto(row: RecipientRow) {
  const reason = row.exclusionReason as ExclusionReason | null;
  return {
    prospectId: row.prospectId,
    fullName: row.fullName,
    email: row.email,
    eligibility: row.eligibility as "eligible" | "excluded",
    exclusionReason: reason,
    exclusionMessage: reason ? (EXCLUSION_MESSAGE[reason] ?? reason) : null,
    emailVerification: row.emailVerification,
    consentStatus: row.consentStatus as "active" | "missing",
    suppressed: reason === "suppressed" || reason === "channel_suppressed" || reason === "hard_bounce",
    decision: row.decision as "included" | "removed",
    decisionComment: row.decisionComment,
    claims: row.claims as RecipientClaims,
    enrolled: Boolean(row.enrollmentId),
    outcome: {
      sentAt: row.sentAt?.toISOString() ?? null,
      repliedAt: row.repliedAt?.toISOString() ?? null,
      bouncedAt: row.bouncedAt?.toISOString() ?? null,
      unsubscribedAt: row.unsubscribedAt?.toISOString() ?? null,
    },
  };
}

function toCampaignDto(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status as CampaignStatus,
    trigger: row.trigger as "manual" | "job_change",
    audienceId: row.audienceId,
    sequenceId: row.sequenceId,
    sourceChangeEventId: row.sourceChangeEventId,
    recipientCount: row.totalProspects,
    consentBasis: row.consentBasis,
    reviewComment: row.reviewComment,
    createdBy: row.createdBy,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    launchedAt: row.startedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type CampaignDto = ReturnType<typeof toCampaignDto>;

async function loadCampaign(db: Db, workspaceId: string, id: string): Promise<CampaignRow> {
  const [row] = await db
    .select()
    .from(enrichmentCampaigns)
    .where(and(eq(enrichmentCampaigns.workspaceId, workspaceId), eq(enrichmentCampaigns.id, id)))
    .limit(1);
  if (!row) throw new CaptureError("campaign_not_found", 404, "This campaign does not exist in your workspace.");
  return row;
}

const loadRecipients = (db: Db, campaignId: string) =>
  db
    .select()
    .from(enrichmentCampaignRecipients)
    .where(eq(enrichmentCampaignRecipients.campaignId, campaignId))
    .orderBy(asc(enrichmentCampaignRecipients.fullName), asc(enrichmentCampaignRecipients.prospectId));

export async function listCampaigns(db: Db, workspaceId: string, filters: { trigger?: "manual" | "job_change"; open?: boolean } = {}) {
  const rows = await db
    .select()
    .from(enrichmentCampaigns)
    .where(
      and(
        eq(enrichmentCampaigns.workspaceId, workspaceId),
        filters.trigger ? eq(enrichmentCampaigns.trigger, filters.trigger) : undefined,
        filters.open ? inArray(enrichmentCampaigns.status, ["draft", "pending_review", "changes_required"]) : undefined
      )
    )
    .orderBy(desc(enrichmentCampaigns.updatedAt))
    .limit(200);
  return rows.map(toCampaignDto);
}

export async function getCampaign(db: Db, config: Env, workspaceId: string, id: string) {
  const row = await loadCampaign(db, workspaceId, id);
  await syncUnsubscribes(db, row);
  const [recipients, reviews] = await Promise.all([
    loadRecipients(db, id),
    db.select().from(enrichmentCampaignReviews).where(eq(enrichmentCampaignReviews.campaignId, id)).orderBy(desc(enrichmentCampaignReviews.createdAt)).limit(50),
  ]);
  const draft = draftOf(row);
  const included = recipients.filter((recipient) => recipient.decision === "included" && recipient.eligibility === "eligible");
  const sandbox = sandboxPolicy(config);
  const count = (pick: (recipient: RecipientRow) => unknown) => recipients.filter(pick).length;
  return {
    campaign: toCampaignDto(row),
    draft,
    problems: draftProblems(draft),
    recipients: recipients.map(toRecipientDto),
    counts: {
      total: recipients.length,
      eligible: count((recipient) => recipient.eligibility === "eligible"),
      excluded: count((recipient) => recipient.eligibility === "excluded"),
      included: included.length,
      withoutTalkingPoint: included.filter((recipient) => !(recipient.claims as RecipientClaims).reason).length,
      consentMissing: included.filter((recipient) => recipient.consentStatus === "missing").length,
    },
    outcomes: {
      enrolled: count((recipient) => recipient.enrollmentId),
      sent: count((recipient) => recipient.sentAt),
      replied: count((recipient) => recipient.repliedAt),
      bounced: count((recipient) => recipient.bouncedAt),
      unsubscribed: count((recipient) => recipient.unsubscribedAt),
    },
    reviews: reviews.map((review) => ({
      id: review.id,
      decision: review.decision,
      comment: review.comment,
      reviewerId: review.reviewerId,
      recipientCount: review.recipientCount,
      createdAt: review.createdAt.toISOString(),
    })),
    /** Send is possible only with a recorded approval. */
    sendEnabled: row.status === "approved" && Boolean(row.approvedAt),
    consentEnforced: config.CONSENT_ENFORCEMENT_ENABLED === true,
    sandbox: { active: sandbox.active, allowedRecipients: sandbox.allowed },
    composer: COMPOSER_VERSION,
    openingToken: OPENING_TOKEN,
  };
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  audienceId?: string;
  prospectIds?: string[];
  trigger?: "manual" | "job_change";
  sourceChangeEventId?: string;
}

async function writeRecipients(db: Db, campaign: CampaignRow, states: RecipientState[]): Promise<void> {
  const now = new Date();
  for (const state of states) {
    const values = {
      fullName: state.fullName,
      email: state.email,
      eligibility: state.eligibility,
      exclusionReason: state.exclusionReason,
      emailVerification: state.emailVerification,
      consentStatus: state.consentStatus,
      claims: state.claims,
      updatedAt: now,
    };
    await db
      .insert(enrichmentCampaignRecipients)
      .values({ campaignId: campaign.id, workspaceId: campaign.workspaceId, prospectId: state.prospectId, ...values })
      .onConflictDoUpdate({ target: [enrichmentCampaignRecipients.campaignId, enrichmentCampaignRecipients.prospectId], set: values });
  }
}

/** Creates a draft campaign: evaluates every recipient and composes their claims. Enrolls nobody. */
export async function createCampaign(db: Db, config: Env, actor: { workspaceId: string; userId: string | null }, input: CreateCampaignInput) {
  const { workspaceId } = actor;
  let prospectIds: string[];
  if (input.audienceId) {
    const audience = await getAudienceRow(db, workspaceId, input.audienceId);
    if (!audience) throw new CaptureError("audience_not_found", 404, "This audience does not exist in your workspace.");
    prospectIds = (await audienceMembers(db, workspaceId, audience.filters as AudienceFilters, MAX_AUDIENCE_SIZE + 1)).map((member) => member.prospectId);
  } else {
    prospectIds = await prospectsExist(db, workspaceId, [...new Set(input.prospectIds ?? [])]);
  }
  if (!prospectIds.length) throw new CaptureError("campaign_empty", 422, "There is nobody to add to this campaign.");
  if (prospectIds.length > MAX_AUDIENCE_SIZE) {
    throw new CaptureError("audience_too_large", 422, `A campaign can have at most ${MAX_AUDIENCE_SIZE} recipients so each one can be reviewed.`);
  }

  const trigger = input.trigger ?? "manual";
  const states = await evaluateAll(db, config, workspaceId, prospectIds, trigger === "job_change");
  const [row] = await db
    .insert(enrichmentCampaigns)
    .values({
      workspaceId,
      name: input.name,
      status: "draft",
      trigger,
      audienceId: input.audienceId ?? null,
      sourceChangeEventId: input.sourceChangeEventId ?? null,
      draft: defaultDraft(trigger === "job_change"),
      totalProspects: states.length,
      createdBy: actor.userId,
    })
    .returning();
  await writeRecipients(db, row!, states);
  await recordPrivilegedAction(db, {
    workspaceId,
    actorId: actor.userId ?? undefined,
    action: "enrichment.campaign.create",
    entityType: "enrichment_campaign",
    entityId: row!.id,
    afterState: { name: input.name, trigger, audienceId: input.audienceId ?? null, recipients: states.length },
  });
  return toCampaignDto(row!);
}

/** An approval covers one exact state. Changing it afterwards withdraws the approval. */
async function invalidateApproval(db: Db, row: CampaignRow, actorId: string | null, reason: string): Promise<void> {
  if (row.status !== "approved" && row.status !== "launched") return;
  await db.insert(enrichmentCampaignReviews).values({
    campaignId: row.id,
    workspaceId: row.workspaceId,
    reviewerId: actorId,
    decision: "invalidated",
    comment: reason,
    fingerprint: row.approvedFingerprint,
  });
  await db
    .update(enrichmentCampaigns)
    .set({ status: "changes_required", approvedFingerprint: null, approvedBy: null, approvedAt: null, reviewComment: reason, updatedAt: new Date() })
    .where(eq(enrichmentCampaigns.id, row.id));
  await db
    .update(enrichmentCampaignRecipients)
    .set({ approvedFingerprint: null })
    .where(and(eq(enrichmentCampaignRecipients.campaignId, row.id), isNull(enrichmentCampaignRecipients.enrollmentId)));
  log.info("campaign approval invalidated", { workspaceId: row.workspaceId, campaignId: row.id, reason });
}

function assertEditable(row: CampaignRow): void {
  if (!EDITABLE.includes(row.status as CampaignStatus)) {
    throw new CaptureError("campaign_not_editable", 409, `A ${row.status} campaign cannot be changed.`);
  }
}

export async function updateDraft(db: Db, actor: CaptureActor, id: string, steps: DraftStep[]) {
  const row = await loadCampaign(db, actor.workspaceId, id);
  assertEditable(row);
  const ordered = [...steps].sort((a, b) => a.order - b.order).map((step, index) => ({ ...step, order: index + 1, delayDays: index === 0 ? 0 : step.delayDays }));
  const draft: CampaignDraft = { schemaVersion: DRAFT_SCHEMA_VERSION, composer: COMPOSER_VERSION, steps: ordered };
  await invalidateApproval(db, row, actor.userId, "The copy was edited after approval.");
  await db.update(enrichmentCampaigns).set({ draft, updatedAt: new Date() }).where(eq(enrichmentCampaigns.id, id));
  return { draft, problems: draftProblems(draft) };
}

export async function setRecipientDecision(db: Db, actor: CaptureActor, id: string, prospectId: string, input: { decision: "included" | "removed"; comment?: string }) {
  const row = await loadCampaign(db, actor.workspaceId, id);
  assertEditable(row);
  const [recipient] = await db
    .select()
    .from(enrichmentCampaignRecipients)
    .where(and(eq(enrichmentCampaignRecipients.campaignId, id), eq(enrichmentCampaignRecipients.prospectId, prospectId)))
    .limit(1);
  if (!recipient) throw new CaptureError("recipient_not_found", 404, "This person is not in the campaign.");
  if (input.decision === "included" && recipient.eligibility !== "eligible") {
    const reason = recipient.exclusionReason as ExclusionReason | null;
    throw new CaptureError("recipient_excluded", 409, `This person cannot be included: ${reason ? EXCLUSION_MESSAGE[reason] : "not eligible"}.`);
  }
  if (recipient.decision !== input.decision) await invalidateApproval(db, row, actor.userId, "The recipients were changed after approval.");
  const [updated] = await db
    .update(enrichmentCampaignRecipients)
    .set({ decision: input.decision, decisionComment: input.comment?.trim() || null, updatedAt: new Date() })
    .where(eq(enrichmentCampaignRecipients.id, recipient.id))
    .returning();
  return toRecipientDto(updated!);
}

/** Re-reads eligibility and evidence for every recipient. */
async function refresh(db: Db, config: Env, row: CampaignRow): Promise<RecipientRow[]> {
  const existing = await loadRecipients(db, row.id);
  // Evidence and addresses of people already enrolled are part of what was sent; leave them.
  const pending = existing.filter((recipient) => !recipient.enrollmentId);
  const states = await evaluateAll(db, config, row.workspaceId, pending.map((recipient) => recipient.prospectId), row.trigger === "job_change");
  await writeRecipients(db, row, states);
  return loadRecipients(db, row.id);
}

export async function refreshCampaign(db: Db, config: Env, actor: CaptureActor, id: string) {
  const row = await loadCampaign(db, actor.workspaceId, id);
  assertEditable(row);
  const recipients = await refresh(db, config, row);
  if (row.status === "approved" && approvalIsStale(row, recipients)) {
    await invalidateApproval(db, row, actor.userId, "Evidence or contact details changed after approval.");
  }
  return getCampaign(db, config, actor.workspaceId, id);
}

// ── Review ───────────────────────────────────────────────────────────────────

export async function submitCampaign(db: Db, config: Env, actor: CaptureActor, id: string) {
  const row = await loadCampaign(db, actor.workspaceId, id);
  if (!["draft", "rejected", "changes_required"].includes(row.status)) {
    throw new CaptureError("campaign_not_submittable", 409, `A ${row.status} campaign cannot be submitted for review.`);
  }
  const problems = draftProblems(draftOf(row));
  if (problems.length) throw new CaptureError("draft_incomplete", 422, problems.join(" "));
  const recipients = await refresh(db, config, row);
  if (!recipients.some((recipient) => recipient.decision === "included" && recipient.eligibility === "eligible")) {
    throw new CaptureError("no_eligible_recipients", 422, "Nobody in this campaign can be contacted. See each recipient's exclusion reason.");
  }
  await db
    .update(enrichmentCampaigns)
    .set({ status: "pending_review", submittedBy: actor.userId, submittedAt: new Date(), updatedAt: new Date() })
    .where(eq(enrichmentCampaigns.id, id));
  await recordPrivilegedAction(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: "enrichment.campaign.submit",
    entityType: "enrichment_campaign",
    entityId: id,
  });
  return getCampaign(db, config, actor.workspaceId, id);
}

export interface ReviewInput {
  decision: "approved" | "rejected";
  comment?: string;
  /** Lawful basis recorded for included recipients who have no consent record. */
  consentBasis?: string;
}

/**
 * Records a reviewer's decision. An approval is taken over the campaign as it is at this
 * moment — eligibility and evidence are re-read first — and stores the fingerprint of it.
 */
export async function reviewCampaign(db: Db, config: Env, actor: CaptureActor, id: string, input: ReviewInput) {
  const row = await loadCampaign(db, actor.workspaceId, id);
  if (row.status !== "pending_review") {
    throw new CaptureError("campaign_not_pending_review", 409, "Only a campaign that has been submitted for review can be approved or rejected.");
  }
  const comment = input.comment?.trim() || null;
  const now = new Date();

  if (input.decision === "rejected") {
    if (!comment) throw new CaptureError("comment_required", 422, "Say what needs to change when rejecting a campaign.");
    await db.insert(enrichmentCampaignReviews).values({ campaignId: id, workspaceId: actor.workspaceId, reviewerId: actor.userId, decision: "rejected", comment });
    await db.update(enrichmentCampaigns).set({ status: "rejected", reviewComment: comment, approvedFingerprint: null, approvedBy: null, approvedAt: null, updatedAt: now }).where(eq(enrichmentCampaigns.id, id));
  } else {
    // A second person approves: whoever created the campaign or submitted it for review may
    // reject (withdraw) it, but not approve their own work.
    if (actor.userId === row.createdBy || actor.userId === row.submittedBy) {
      throw new CaptureError(
        "self_approval_not_allowed",
        403,
        "Someone other than the person who created or submitted this campaign must approve it."
      );
    }
    const problems = draftProblems(draftOf(row));
    if (problems.length) throw new CaptureError("draft_incomplete", 422, problems.join(" "));
    const recipients = await refresh(db, config, row);
    const included = recipients.filter((recipient) => recipient.decision === "included" && recipient.eligibility === "eligible");
    if (!included.length) throw new CaptureError("no_eligible_recipients", 422, "Nobody in this campaign can be contacted any more.");
    const consentBasis = input.consentBasis?.trim() || null;
    if (config.CONSENT_ENFORCEMENT_ENABLED && !consentBasis && included.some((recipient) => recipient.consentStatus === "missing")) {
      throw new CaptureError("consent_basis_required", 422, "Some recipients have no consent record. Give the lawful basis for contacting them, or remove them.");
    }
    const approved = draftFingerprint(draftOf(row));
    for (const recipient of included) {
      if (recipient.enrollmentId) continue;
      await db.update(enrichmentCampaignRecipients).set({ approvedFingerprint: fingerprintOf(recipient) }).where(eq(enrichmentCampaignRecipients.id, recipient.id));
    }
    await db.insert(enrichmentCampaignReviews).values({
      campaignId: id,
      workspaceId: actor.workspaceId,
      reviewerId: actor.userId,
      decision: "approved",
      comment,
      fingerprint: approved,
      recipientCount: included.length,
    });
    await db
      .update(enrichmentCampaigns)
      // A campaign that was already launched and needed re-review goes back to launched.
      .set({ status: row.sequenceId ? "launched" : "approved", approvedFingerprint: approved, approvedBy: actor.userId, approvedAt: now, consentBasis, reviewComment: comment, updatedAt: now })
      .where(eq(enrichmentCampaigns.id, id));
    if (row.sequenceId) await writeStepOneDrafts(db, { ...row, approvedBy: actor.userId, approvedAt: now }, recipients);
  }
  await recordPrivilegedAction(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: input.decision === "approved" ? "enrichment.campaign.approve" : "enrichment.campaign.reject",
    entityType: "enrichment_campaign",
    entityId: id,
    afterState: { decision: input.decision, comment },
  });
  return getCampaign(db, config, actor.workspaceId, id);
}

export async function dismissCampaign(db: Db, config: Env, actor: CaptureActor, id: string, comment?: string) {
  const row = await loadCampaign(db, actor.workspaceId, id);
  if (row.sequenceId) throw new CaptureError("campaign_not_editable", 409, "A launched campaign cannot be dismissed. Pause its sequence instead.");
  await db.update(enrichmentCampaigns).set({ status: "dismissed", reviewComment: comment?.trim() || null, approvedFingerprint: null, approvedAt: null, approvedBy: null, updatedAt: new Date() }).where(eq(enrichmentCampaigns.id, id));
  await recordPrivilegedAction(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: "enrichment.campaign.dismiss", entityType: "enrichment_campaign", entityId: id });
  return getCampaign(db, config, actor.workspaceId, id);
}

// ── Launch ───────────────────────────────────────────────────────────────────

/**
 * Stores each enrolled recipient's step-1 copy as an approved draft tied to their enrollment
 * step — the mechanism the sequence worker already uses to send reviewed copy instead of the
 * step template.
 */
async function writeStepOneDrafts(db: Db, campaign: CampaignRow, recipients: RecipientRow[]): Promise<void> {
  if (!campaign.sequenceId) return;
  const [stepOne] = draftOf(campaign).steps;
  const [sequenceStep] = await db.select({ id: sequenceSteps.id }).from(sequenceSteps).where(eq(sequenceSteps.sequenceId, campaign.sequenceId)).orderBy(asc(sequenceSteps.stepOrder)).limit(1);
  if (!stepOne || !sequenceStep) return;
  for (const recipient of recipients) {
    if (!recipient.enrollmentId || recipient.sentAt) continue;
    const [enrollmentStep] = await db
      .select({ id: sequenceEnrollmentSteps.id })
      .from(sequenceEnrollmentSteps)
      .where(and(eq(sequenceEnrollmentSteps.enrollmentId, recipient.enrollmentId), eq(sequenceEnrollmentSteps.stepId, sequenceStep.id)))
      .limit(1);
    if (!enrollmentStep) continue;
    await db.delete(aiDrafts).where(and(eq(aiDrafts.workspaceId, campaign.workspaceId), eq(aiDrafts.enrollmentStepId, enrollmentStep.id), isNull(aiDrafts.threadId)));
    await db.insert(aiDrafts).values({
      workspaceId: campaign.workspaceId,
      prospectId: recipient.prospectId,
      enrollmentStepId: enrollmentStep.id,
      subject: stepOne.subject,
      body: renderBody(stepOne.body, (recipient.claims as RecipientClaims).opening ?? ""),
      status: "approved",
      model: COMPOSER_VERSION,
      reviewedAt: campaign.approvedAt ?? new Date(),
      reviewedBy: campaign.approvedBy,
    });
  }
}

export interface LaunchResult {
  enrolled: number;
  /** People the approval covered, or who were in the campaign, but who were not enrolled, and why. */
  skipped: Array<{ prospectId: string; reason: ExclusionReason | "already_enrolled" | "not_in_approval" }>;
  sequenceId: string;
  newEnrollments: Array<{ enrollmentId: string; prospectId: string; firstStepScheduledAt: Date | null }>;
}

/**
 * Launches an approved campaign: creates the sequence and enrolls the approved recipients
 * through the existing enroll path. Refused unless an approval is on record for exactly the
 * current copy, recipients and evidence. Eligibility is checked again here, so a person
 * suppressed or bounced since approval is left out.
 */
export async function launchCampaign(db: Db, config: Env, actor: CaptureActor, id: string): Promise<LaunchResult> {
  const { workspaceId } = actor;
  const claimed = await db
    .update(enrichmentCampaigns)
    .set({ updatedAt: new Date() })
    .where(and(eq(enrichmentCampaigns.workspaceId, workspaceId), eq(enrichmentCampaigns.id, id), eq(enrichmentCampaigns.status, "approved"), isNull(enrichmentCampaigns.sequenceId)))
    .returning();
  const row = claimed[0];
  if (!row || !row.approvedAt || !row.approvedBy || !row.approvedFingerprint) {
    await loadCampaign(db, workspaceId, id);
    throw new CaptureError("approval_required", 409, "This campaign has no recorded approval. A reviewer must approve the recipients and copy before it can be sent.");
  }

  const recipients = await refresh(db, config, row);
  if (approvalIsStale(row, recipients)) {
    await invalidateApproval(db, row, actor.userId, "Evidence or contact details changed after approval.");
    throw new CaptureError("re_review_required", 409, "Evidence or contact details changed after this campaign was approved. It needs to be reviewed again.");
  }

  const skipped: LaunchResult["skipped"] = [];
  const toEnroll: RecipientRow[] = [];
  for (const recipient of recipients) {
    if (recipient.decision !== "included") continue;
    if (recipient.eligibility !== "eligible") {
      skipped.push({ prospectId: recipient.prospectId, reason: (recipient.exclusionReason as ExclusionReason) ?? "email_not_verified" });
      continue;
    }
    // Became contactable only after the approval: the reviewer never approved them.
    if (!recipient.approvedFingerprint) {
      skipped.push({ prospectId: recipient.prospectId, reason: "not_in_approval" });
      continue;
    }
    if (recipient.consentStatus === "missing" && !row.consentBasis && config.CONSENT_ENFORCEMENT_ENABLED) {
      skipped.push({ prospectId: recipient.prospectId, reason: "consent_missing" });
      continue;
    }
    toEnroll.push(recipient);
  }
  if (!toEnroll.length) throw new CaptureError("no_eligible_recipients", 422, "Nobody in this campaign can be contacted any more.");

  const prospectIds = toEnroll.map((recipient) => recipient.prospectId);
  const consent = await gateEnrollConsent(db, config, { workspaceId, prospectIds, consentBasis: row.consentBasis ?? undefined, recordedBy: row.approvedBy });
  if (!consent.ok) throw new CaptureError("consent_required", 403, "Active email consent is required before enrolling these recipients.");

  const sequences = buildSequenceService(db)!;
  const draft = draftOf(row);
  const sequence = await sequences.createSequence(workspaceId, row.name, { source: "template", templateKey: `enrichment_campaign:${row.id}` });
  for (const step of draft.steps) {
    // The stored template never contains a claim: a recipient's claims travel only in their approved draft.
    await sequences.addStep(workspaceId, sequence.id, { stepType: "email", delayDays: step.delayDays, delayUnit: "days", subject: step.subject, bodyTemplate: renderBody(step.body, "") });
  }
  await sequences.updateSequence(workspaceId, sequence.id, { status: "active" });
  const launched: CampaignRow = { ...row, sequenceId: sequence.id };
  await db.update(enrichmentCampaigns).set({ sequenceId: sequence.id, status: "launched", startedAt: new Date(), updatedAt: new Date() }).where(eq(enrichmentCampaigns.id, id));

  const result = await sequences.enroll(sequence.id, workspaceId, { prospectIds });
  const enrollmentByProspect = new Map(result.newEnrollments.map((enrollment) => [enrollment.prospectId, enrollment.enrollmentId]));
  for (const recipient of toEnroll) {
    const enrollmentId = enrollmentByProspect.get(recipient.prospectId);
    if (!enrollmentId) {
      skipped.push({ prospectId: recipient.prospectId, reason: "already_enrolled" });
      continue;
    }
    await db.update(enrichmentCampaignRecipients).set({ enrollmentId, updatedAt: new Date() }).where(eq(enrichmentCampaignRecipients.id, recipient.id));
  }
  await writeStepOneDrafts(db, launched, await loadRecipients(db, id));

  await recordPrivilegedAction(db, {
    workspaceId,
    actorId: actor.userId,
    action: "enrichment.campaign.launch",
    entityType: "enrichment_campaign",
    entityId: id,
    afterState: { sequenceId: sequence.id, enrolled: result.enrolled, skipped: skipped.length, approvedBy: row.approvedBy, approvedAt: row.approvedAt.toISOString() },
  });
  log.info("campaign launched", { workspaceId, campaignId: id, sequenceId: sequence.id, enrolled: result.enrolled, skipped: skipped.length });
  return { enrolled: result.enrolled, skipped, sequenceId: sequence.id, newEnrollments: result.newEnrollments };
}

// ── Send-time gate ───────────────────────────────────────────────────────────

export type SendGate =
  | { allowed: true }
  /** `retry` = wait and ask again (an approval can be given); otherwise this send will never be allowed. */
  | { allowed: false; reason: string; retry: boolean };

/**
 * Asked by the sequence worker before every email. For an enrollment that did not come from a
 * campaign it allows the send and changes nothing. For a campaign enrollment it requires a
 * standing approval, the approved address, a still-valid verification, unchanged evidence
 * behind the claims that are about to be sent, and — outside production — a sandbox recipient.
 */
export async function campaignSendGate(db: Db, config: Env, workspaceId: string, enrollmentId: string, email: string): Promise<SendGate> {
  const [recipient] = await db
    .select()
    .from(enrichmentCampaignRecipients)
    .where(and(eq(enrichmentCampaignRecipients.workspaceId, workspaceId), eq(enrichmentCampaignRecipients.enrollmentId, enrollmentId)))
    .limit(1);
  if (!recipient) return { allowed: true };
  const [campaign] = await db.select().from(enrichmentCampaigns).where(eq(enrichmentCampaigns.id, recipient.campaignId)).limit(1);
  if (!campaign || campaign.status !== "launched" || !campaign.approvedAt || !campaign.approvedBy) {
    return { allowed: false, reason: "campaign_approval_required", retry: campaign?.status === "changes_required" || campaign?.status === "pending_review" };
  }
  if (recipient.decision !== "included" || !recipient.approvedFingerprint) return { allowed: false, reason: "campaign_recipient_not_approved", retry: false };
  if (!sandboxPolicy(config).allows(email)) return { allowed: false, reason: "sandbox_recipient_blocked", retry: false };
  if ((recipient.email ?? "") !== email.trim().toLowerCase()) return { allowed: false, reason: "campaign_recipient_email_changed", retry: false };

  // The address must still be the one on record, and still verified as valid.
  const current = await getContactData(db, workspaceId, recipient.prospectId);
  if (current?.email?.value.toLowerCase() !== recipient.email || current.email.verification.status !== "valid") {
    return { allowed: false, reason: "email_not_verified", retry: false };
  }

  // The claims go out in step 1. Until then, the evidence behind them must be what was approved.
  if (!recipient.sentAt) {
    const state = await evaluateRecipient(db, config, workspaceId, recipient.prospectId, campaign.trigger === "job_change");
    if (recipient.approvedFingerprint !== recipientFingerprint(recipient.prospectId, recipient.email, state.claims)) {
      await invalidateApproval(db, campaign, null, "Evidence changed after approval, before the first email was sent.");
      return { allowed: false, reason: "campaign_re_review_required", retry: true };
    }
  }
  return { allowed: true };
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

export type CampaignOutcome = "sent" | "replied" | "bounced" | "unsubscribed";
const OUTCOME_COLUMN = { sent: "sentAt", replied: "repliedAt", bounced: "bouncedAt", unsubscribed: "unsubscribedAt" } as const;

async function applyOutcome(db: Db, recipient: RecipientRow, outcome: CampaignOutcome, at: Date): Promise<boolean> {
  const column = OUTCOME_COLUMN[outcome];
  if (recipient[column]) return false;
  await db.update(enrichmentCampaignRecipients).set({ [column]: at, updatedAt: at }).where(eq(enrichmentCampaignRecipients.id, recipient.id));
  const [campaign] = await db.select({ audienceId: enrichmentCampaigns.audienceId }).from(enrichmentCampaigns).where(eq(enrichmentCampaigns.id, recipient.campaignId)).limit(1);
  if (campaign?.audienceId) await addAudienceOutcome(db, recipient.workspaceId, campaign.audienceId, outcome);
  return true;
}

/**
 * Outcome hook, called by the sequence worker. Records what happened to a campaign recipient
 * and feeds it back: a reply or a bounce is evidence about the address, a hard bounce
 * suppresses it, and every outcome counts toward the quality of the audience it came from.
 * Does nothing for an enrollment that is not part of a campaign.
 */
export async function recordCampaignOutcome(db: Db, workspaceId: string, enrollmentId: string, outcome: Exclude<CampaignOutcome, "unsubscribed">, at = new Date()): Promise<void> {
  const [recipient] = await db
    .select()
    .from(enrichmentCampaignRecipients)
    .where(and(eq(enrichmentCampaignRecipients.workspaceId, workspaceId), eq(enrichmentCampaignRecipients.enrollmentId, enrollmentId)))
    .limit(1);
  if (!recipient || !(await applyOutcome(db, recipient, outcome, at))) return;
  if (outcome === "sent") {
    await db.update(enrichmentCampaigns).set({ completedProspects: sql`${enrichmentCampaigns.completedProspects} + 1` }).where(eq(enrichmentCampaigns.id, recipient.campaignId));
    return;
  }
  const email = recipient.email;
  if (!email) return;
  if (outcome === "bounced") {
    await addSuppression(db, workspaceId, email, "hard_bounce");
    // The address is no longer verified: it cannot be enrolled again until re-verified.
    await db
      .update(emailVerifications)
      .set({ status: "invalid", deliverabilityScore: 0, provider: "sequence_bounce", verifiedAt: at })
      .where(and(eq(emailVerifications.workspaceId, workspaceId), eq(emailVerifications.prospectId, recipient.prospectId), sql`lower(${emailVerifications.email}) = ${email}`));
  }
  await recordEvidence(db, {
    workspaceId,
    entityType: "prospect",
    entityId: recipient.prospectId,
    attribute: "email_deliverability",
    value: { email, status: outcome === "bounced" ? "invalid" : "valid", outcome },
    source: "skout_sequence",
    observedAt: at,
    confidence: outcome === "bounced" ? 0.95 : 1,
    method: outcome === "bounced" ? "hard_bounce" : "reply_received",
  }).catch((error) => log.warn("outcome evidence write failed", { workspaceId, prospectId: recipient.prospectId, err: error }));
}

/** Unsubscribes arrive through the public unsubscribe link, as suppression rows; pick them up for this campaign. */
async function syncUnsubscribes(db: Db, campaign: CampaignRow): Promise<void> {
  if (!campaign.sequenceId) return;
  const rows = await db
    .select({ recipient: enrichmentCampaignRecipients, suppressedAt: suppressions.createdAt })
    .from(enrichmentCampaignRecipients)
    .innerJoin(suppressions, and(eq(suppressions.workspaceId, enrichmentCampaignRecipients.workspaceId), eq(suppressions.email, enrichmentCampaignRecipients.email), eq(suppressions.reason, "unsubscribed")))
    .where(and(eq(enrichmentCampaignRecipients.campaignId, campaign.id), isNull(enrichmentCampaignRecipients.unsubscribedAt), sql`${enrichmentCampaignRecipients.sentAt} is not null`));
  for (const { recipient, suppressedAt } of rows) {
    if (suppressedAt >= recipient.sentAt!) await applyOutcome(db, recipient, "unsubscribed", suppressedAt);
  }
}

// ── Job changes ──────────────────────────────────────────────────────────────

/**
 * Turns detected job changes into review items: a draft campaign for the one person, composed
 * from their current evidence, waiting in the review queue. It is a suggestion. It is not
 * submitted, approved, enrolled or sent by anything but a person.
 */
export async function suggestForJobChanges(db: Db, config: Env, workspaceId: string, limit = 25): Promise<number> {
  const pending = await db
    .select({ id: enrichmentChangeEvents.id, prospectId: enrichmentChangeEvents.entityId })
    .from(enrichmentChangeEvents)
    .leftJoin(enrichmentCampaigns, and(eq(enrichmentCampaigns.workspaceId, enrichmentChangeEvents.workspaceId), eq(enrichmentCampaigns.sourceChangeEventId, enrichmentChangeEvents.id)))
    .where(
      and(
        eq(enrichmentChangeEvents.workspaceId, workspaceId),
        eq(enrichmentChangeEvents.entityType, "person"),
        eq(enrichmentChangeEvents.isJobChange, true),
        isNull(enrichmentChangeEvents.reviewedAt),
        isNull(enrichmentCampaigns.id)
      )
    )
    .orderBy(desc(enrichmentChangeEvents.detectedAt))
    .limit(limit);

  let created = 0;
  for (const change of pending) {
    const [person] = await db
      .select({ fullName: sql<string | null>`${prospectActivations.snapshot}->>'fullName'` })
      .from(prospectActivations)
      .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, change.prospectId)))
      .limit(1);
    if (!person) continue;
    try {
      await createCampaign(db, config, { workspaceId, userId: null }, {
        name: `Job change: ${person.fullName ?? "captured person"}`,
        prospectIds: [change.prospectId],
        trigger: "job_change",
        sourceChangeEventId: change.id,
      });
      created += 1;
    } catch (error) {
      // Another request created it first (unique per change event), or the person is gone.
      log.info("job-change suggestion not created", { workspaceId, changeEventId: change.id, err: error });
    }
  }
  return created;
}

/** The job-change review queue: suggestions nobody has acted on yet. */
export async function jobChangeReviewQueue(db: Db, config: Env, workspaceId: string) {
  await suggestForJobChanges(db, config, workspaceId);
  const campaigns = await listCampaigns(db, workspaceId, { trigger: "job_change", open: true });
  if (!campaigns.length) return [];
  const recipients = await db
    .select()
    .from(enrichmentCampaignRecipients)
    .where(inArray(enrichmentCampaignRecipients.campaignId, campaigns.map((campaign) => campaign.id)));
  const byCampaign = new Map(recipients.map((recipient) => [recipient.campaignId, recipient]));
  return campaigns.map((campaign) => {
    const recipient = byCampaign.get(campaign.id);
    return { campaign, recipient: recipient ? toRecipientDto(recipient) : null, claimsInCopy: recipient ? claimsInCopy(recipient.claims as RecipientClaims) : [] };
  });
}
