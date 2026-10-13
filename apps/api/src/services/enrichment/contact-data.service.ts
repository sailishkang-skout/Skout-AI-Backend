/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md.
 *   - Tables touched directly: contacts (owned by apps/crm) — read only
 *   - Reason: the contact-data panel shows the CRM record's email/phone next to the provider
 *     results that produced them, with one provenance per value.
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../../config/env.js";
import { isEmailIntelConfigured, verifyEmailAsVerdict } from "../email-intel.service.js";
import { recordEvidence } from "../evidence.service.js";
import { CaptureError, type CaptureActor } from "./capture-ingest.service.js";
import { resolveEmailVerifier } from "./index.js";

/**
 * ENR-04 — contact data with provenance and verification status.
 *
 * An email or phone number is shown only when something stands behind it: a provider result
 * recorded on an enrichment job, or a value on the CRM record. Each value carries who supplied
 * it, when, and a verification status — "unverified" when nobody has verified it. When there
 * is no value, the field is absent; nothing is derived to fill the gap. A pattern-built address
 * counts only once the verification service has confirmed it, and is labelled as such.
 */

const log = createLogger("enrichment.contact-data");
const { contacts, emailVerifications, enrichmentJobs, enrichmentResults, prospectActivations } = schema;

/** Contact data older than this is shown as stale. */
export const CONTACT_FRESHNESS_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Result "providers" that are not a provider supplying data. */
const PATTERN_PROVIDER = "pattern-gen";
const isStub = (provider: string) => provider.startsWith("stub");
const NON_SOURCES = new Set(["phone-gate"]);
/** A value the waterfall carried over from the workspace's own record rather than fetched. */
const CARRIED_OVER = new Set(["internal_graph", "activation"]);

export type VerificationStatus = "valid" | "invalid" | "catch_all" | "risky" | "unknown" | "unverified";

export interface ContactValue {
  value: string;
  provenance: {
    /**
     * provider — returned by an enrichment provider;
     * workspace_record — already on the workspace's record when enrichment ran;
     * pattern_verified — built from a name pattern and then confirmed by the verifier;
     * manual — entered by a teammate;
     * crm_record — on the CRM contact with no recorded source.
     */
    kind: "provider" | "workspace_record" | "pattern_verified" | "manual" | "crm_record";
    provider: string;
    jobId: string | null;
    correlationId: string | null;
    confidence: number | null;
    observedAt: string | null;
  };
  verification: {
    status: VerificationStatus;
    /** Who checked it; null when nobody has. */
    provider: string | null;
    verifiedAt: string | null;
    deliverabilityScore: number | null;
  };
  freshness: {
    observedAt: string | null;
    ageDays: number | null;
    stale: boolean;
  };
}

export interface ContactData {
  prospectId: string;
  contactId: string | null;
  /** Null when there is no email. It stays null until a provider or a person supplies one. */
  email: ContactValue | null;
  phone: ContactValue | null;
  /** Other phone numbers the same provider result carried. */
  otherPhones: Array<{ type: "direct" | "hq"; value: string }>;
  lastRun: { jobId: string; status: string; completedAt: string | null; queuedAt: string } | null;
  freshnessDays: number;
}

function freshness(observedAt: Date | null, now: number): ContactValue["freshness"] {
  if (!observedAt) return { observedAt: null, ageDays: null, stale: false };
  const ageDays = Math.floor((now - observedAt.getTime()) / DAY_MS);
  return { observedAt: observedAt.toISOString(), ageDays, stale: ageDays > CONTACT_FRESHNESS_DAYS };
}

const UNVERIFIED: ContactValue["verification"] = { status: "unverified", provider: null, verifiedAt: null, deliverabilityScore: null };
const VERDICTS = new Set(["valid", "invalid", "catch_all", "risky", "unknown"]);
const asVerdict = (value: unknown): VerificationStatus => (typeof value === "string" && VERDICTS.has(value) ? (value as VerificationStatus) : "unverified");

type ResultRow = typeof enrichmentResults.$inferSelect & { correlationId: string };
type FieldSources = Record<string, { source?: string; confidence?: number; setAt?: string } | undefined>;

function recordValue(value: string | null | undefined, fieldSources: unknown, field: string, updatedAt: Date, now: number): ContactValue | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const entry = ((fieldSources ?? {}) as FieldSources)[field];
  const setAt = entry?.setAt ? new Date(entry.setAt) : null;
  const observedAt = setAt && !Number.isNaN(setAt.getTime()) ? setAt : updatedAt;
  const manual = entry?.source === "manual";
  return {
    value: trimmed,
    provenance: {
      kind: manual ? "manual" : "crm_record",
      provider: entry?.source ?? "unattributed",
      jobId: null,
      correlationId: null,
      confidence: typeof entry?.confidence === "number" ? entry.confidence : null,
      observedAt: observedAt.toISOString(),
    },
    verification: UNVERIFIED,
    freshness: freshness(observedAt, now),
  };
}

export async function getContactData(db: Db, workspaceId: string, prospectId: string, now = new Date()): Promise<ContactData | null> {
  const [activation] = await db
    .select({ id: prospectActivations.id })
    .from(prospectActivations)
    .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)))
    .limit(1);
  if (!activation) return null;

  const [[contact], results, [verification], [lastJob]] = await Promise.all([
    db
      .select({ id: contacts.id, email: contacts.email, phone: contacts.phone, fieldSources: contacts.fieldSources, updatedAt: contacts.updatedAt })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.sourceProspectId, prospectId), isNull(contacts.deletedAt)))
      .limit(1),
    db
      .select({
        id: enrichmentResults.id,
        enrichmentJobId: enrichmentResults.enrichmentJobId,
        workspaceId: enrichmentResults.workspaceId,
        prospectId: enrichmentResults.prospectId,
        fieldName: enrichmentResults.fieldName,
        fieldValue: enrichmentResults.fieldValue,
        fieldValueJson: enrichmentResults.fieldValueJson,
        sourceProvider: enrichmentResults.sourceProvider,
        confidence: enrichmentResults.confidence,
        validationStatus: enrichmentResults.validationStatus,
        isPrimary: enrichmentResults.isPrimary,
        createdAt: enrichmentResults.createdAt,
        correlationId: enrichmentJobs.correlationId,
      })
      .from(enrichmentResults)
      .innerJoin(enrichmentJobs, eq(enrichmentJobs.id, enrichmentResults.enrichmentJobId))
      .where(
        and(
          eq(enrichmentResults.workspaceId, workspaceId),
          eq(enrichmentResults.prospectId, prospectId),
          inArray(enrichmentResults.fieldName, ["email", "email_status", "phone"])
        )
      )
      .orderBy(desc(enrichmentResults.createdAt))
      .limit(200),
    db
      .select()
      .from(emailVerifications)
      .where(and(eq(emailVerifications.workspaceId, workspaceId), eq(emailVerifications.prospectId, prospectId)))
      .limit(1),
    db
      .select({ id: enrichmentJobs.id, status: enrichmentJobs.status, completedAt: enrichmentJobs.completedAt, queuedAt: enrichmentJobs.queuedAt })
      .from(enrichmentJobs)
      .where(and(eq(enrichmentJobs.workspaceId, workspaceId), eq(enrichmentJobs.prospectId, prospectId), eq(enrichmentJobs.kind, "contact_waterfall")))
      .orderBy(desc(enrichmentJobs.queuedAt))
      .limit(1),
  ]);

  const nowMs = now.getTime();
  const rows = results as ResultRow[];
  const statusOf = (jobId: string) => rows.find((row) => row.enrichmentJobId === jobId && row.fieldName === "email_status");

  let email: ContactValue | null = null;
  for (const row of rows) {
    if (row.fieldName !== "email" || !row.fieldValue?.trim() || isStub(row.sourceProvider)) continue;
    const verdict = statusOf(row.enrichmentJobId);
    const verdictStatus = verdict && !isStub(verdict.sourceProvider) ? asVerdict(verdict.validationStatus ?? verdict.fieldValue) : "unverified";
    const pattern = row.sourceProvider === PATTERN_PROVIDER;
    // A pattern-built address is a guess until the verifier has confirmed that exact address.
    if (pattern && verdictStatus !== "valid") continue;
    const score = (verdict?.fieldValueJson as { deliverabilityScore?: unknown } | null)?.deliverabilityScore;
    email = {
      value: row.fieldValue.trim(),
      provenance: {
        kind: pattern ? "pattern_verified" : CARRIED_OVER.has(row.sourceProvider) ? "workspace_record" : "provider",
        provider: row.sourceProvider,
        jobId: row.enrichmentJobId,
        correlationId: row.correlationId,
        confidence: row.confidence === null ? null : Number(row.confidence),
        observedAt: row.createdAt.toISOString(),
      },
      verification:
        verdict && verdictStatus !== "unverified"
          ? {
              status: verdictStatus,
              provider: verdict.sourceProvider,
              verifiedAt: verdict.createdAt.toISOString(),
              deliverabilityScore: typeof score === "number" ? score : null,
            }
          : UNVERIFIED,
      freshness: freshness(row.createdAt, nowMs),
    };
    break;
  }
  email ??= contact ? recordValue(contact.email, contact.fieldSources, "email", contact.updatedAt, nowMs) : null;

  // The stored verdict applies only to the address it was given for.
  if (email && verification && verification.email.trim().toLowerCase() === email.value.toLowerCase() && verification.status !== "no_email") {
    const stored = { at: verification.verifiedAt, existing: email.verification.verifiedAt ? new Date(email.verification.verifiedAt) : null };
    if (!isStub(verification.provider ?? "") && (!stored.existing || stored.at >= stored.existing)) {
      email.verification = {
        status: asVerdict(verification.status),
        provider: verification.provider ?? "unattributed",
        verifiedAt: verification.verifiedAt.toISOString(),
        deliverabilityScore: verification.deliverabilityScore,
      };
    }
  }

  let phone: ContactValue | null = null;
  let otherPhones: ContactData["otherPhones"] = [];
  for (const row of rows) {
    if (row.fieldName !== "phone" || NON_SOURCES.has(row.sourceProvider) || isStub(row.sourceProvider)) continue;
    const detail = (row.fieldValueJson ?? {}) as { mobile?: string; direct?: string; hq?: string; sampleData?: boolean };
    // A provider's sample payload is not this person's number.
    if (detail.sampleData || row.validationStatus === "sample") continue;
    const value = row.fieldValue?.trim();
    if (!value) continue;
    phone = {
      value,
      provenance: {
        kind: "provider",
        provider: row.sourceProvider,
        jobId: row.enrichmentJobId,
        correlationId: row.correlationId,
        confidence: row.confidence === null ? null : Number(row.confidence),
        observedAt: row.createdAt.toISOString(),
      },
      // Phone providers in the waterfall return a number without a verification status.
      verification: UNVERIFIED,
      freshness: freshness(row.createdAt, nowMs),
    };
    otherPhones = (["direct", "hq"] as const)
      .map((type) => ({ type, value: detail[type]?.trim() ?? "" }))
      .filter((entry) => entry.value && entry.value !== value);
    break;
  }
  phone ??= contact ? recordValue(contact.phone, contact.fieldSources, "phone", contact.updatedAt, nowMs) : null;

  return {
    prospectId,
    contactId: contact?.id ?? null,
    email,
    phone,
    otherPhones,
    lastRun: lastJob
      ? {
          jobId: lastJob.id,
          status: lastJob.status === "completed" ? "done" : lastJob.status,
          completedAt: lastJob.completedAt?.toISOString() ?? null,
          queuedAt: lastJob.queuedAt.toISOString(),
        }
      : null,
    freshnessDays: CONTACT_FRESHNESS_DAYS,
  };
}

/**
 * Verifies the person's current email through the platform's verification service: the
 * in-house Email Intelligence service when it is configured, otherwise the workspace's
 * verifier from the provider waterfall. The verdict is stored for exactly that address.
 */
export async function verifyContactEmail(db: Db, config: Env, actor: CaptureActor, prospectId: string): Promise<ContactData | null> {
  const current = await getContactData(db, actor.workspaceId, prospectId);
  if (!current) return null;
  if (!current.email) throw new CaptureError("no_email", 409, "There is no email on this record to verify.");
  const email = current.email.value;
  const now = new Date();

  let verdict: { status: string; deliverabilityScore: number; catchAll: boolean; risky: boolean } | null = null;
  let provider = "email-intel";
  if (isEmailIntelConfigured(config)) verdict = await verifyEmailAsVerdict(config, email);
  if (!verdict) {
    const verifier = await resolveEmailVerifier(db, config, actor.workspaceId);
    // The stub answers from a fixed rule, not from the mailbox: it is not a verification.
    if (isStub(verifier.name)) {
      throw new CaptureError("verifier_not_configured", 503, "No email verification service is configured for this workspace.");
    }
    provider = verifier.name;
    try {
      verdict = await verifier.verify(email);
    } catch (error) {
      log.warn("email verification failed", { workspaceId: actor.workspaceId, prospectId, provider, err: error });
      throw new CaptureError("verifier_unavailable", 502, "The verification service did not answer. Try again shortly.");
    }
  }

  await db
    .insert(emailVerifications)
    .values({
      workspaceId: actor.workspaceId,
      prospectId,
      email,
      status: verdict.status,
      deliverabilityScore: Math.round(verdict.deliverabilityScore),
      catchAll: verdict.catchAll,
      risky: verdict.risky,
      provider,
      verifiedAt: now,
    })
    .onConflictDoUpdate({
      target: [emailVerifications.workspaceId, emailVerifications.prospectId],
      set: {
        email,
        status: verdict.status,
        deliverabilityScore: Math.round(verdict.deliverabilityScore),
        catchAll: verdict.catchAll,
        risky: verdict.risky,
        provider,
        verifiedAt: now,
      },
    });
  try {
    await recordEvidence(db, {
      workspaceId: actor.workspaceId,
      entityType: "prospect",
      entityId: prospectId,
      attribute: "email_deliverability",
      value: { email, status: verdict.status, catchAll: verdict.catchAll, risky: verdict.risky },
      source: provider === "email-intel" ? "email_intelligence_tool" : provider,
      observedAt: now,
      confidence: Math.min(Math.max(verdict.deliverabilityScore / 100, 0), 1),
      method: "email_verification",
    });
  } catch (error) {
    // The verdict is stored either way; the ledger copy is best-effort, as in list verification.
    log.warn("evidence ledger write failed for email verification", { workspaceId: actor.workspaceId, prospectId, err: error });
  }
  return getContactData(db, actor.workspaceId, prospectId);
}
