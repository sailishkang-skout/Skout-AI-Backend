import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { buildEntitlementsService } from "../entitlements.service.js";
import { hashValue } from "./capture-identity.js";

/**
 * ENR-03 — observed LinkedIn facts in the canonical Evidence Ledger.
 *
 * Every fact a capture stores is also written to `evidence_ledger` with the page it was seen
 * on, when it was seen, how it was read, a confidence, and whether it is `verified` (read on
 * the person's or company's own page) or `discovery` (read on a search card). LinkedIn content
 * is observed and often self-reported, so no capture source is given confidence 1.
 */

const { evidenceLedger } = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export type EvidenceState = "verified" | "discovery";

export const CAPTURE_EVIDENCE_SOURCES = {
  publicProfile: { source: "linkedin_public_profile", confidence: 0.9, state: "verified" },
  companyPage: { source: "linkedin_company_page", confidence: 0.85, state: "verified" },
  salesSearchCard: { source: "sales_navigator_search_result", confidence: 0.5, state: "discovery" },
  companyPeopleCard: { source: "linkedin_company_people_result", confidence: 0.5, state: "discovery" },
  /** A reviewer attached or entered the URL themselves. */
  manual: { source: "manual_linkedin_url", confidence: 1, state: "verified" },
} as const satisfies Record<string, { source: string; confidence: number; state: EvidenceState }>;

export type CaptureEvidenceSource = keyof typeof CAPTURE_EVIDENCE_SOURCES;

/** Sources whose rows are derived from capture and are removed with the record they describe. */
export const CAPTURE_DERIVED_SOURCES: string[] = [
  ...Object.values(CAPTURE_EVIDENCE_SOURCES).map((entry) => entry.source),
  "identity_link",
];

export const EVIDENCE_POLICY = {
  permittedPurpose: "sales_research",
  consentBasis: "legitimate_interest",
  method: "extension_rendered_dom",
  /** Values the extension derives from a title rather than reads from the page. */
  inferredMethod: "inferred_from_title",
  inferredConfidence: 0.6,
  DEFAULT_RETENTION_DAYS: 365,
  FRESHNESS_DAYS: 90,
} as const;

export const RETENTION_ENTITLEMENT = "enrichment.evidence_retention_days";

const DAY_MS = 24 * 60 * 60 * 1000;
const INFERRED_ATTRIBUTES = new Set(["seniority", "jobFunction"]);

export async function readRetentionDays(db: Db, workspaceId: string): Promise<number> {
  const value = await buildEntitlementsService(db)!.getValueOr<unknown>(
    workspaceId,
    RETENTION_ENTITLEMENT,
    EVIDENCE_POLICY.DEFAULT_RETENTION_DAYS
  );
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3650
    ? value
    : EVIDENCE_POLICY.DEFAULT_RETENTION_DAYS;
}

export interface ObservedFactsInput {
  workspaceId: string;
  entityType: "prospect" | "company";
  entityId: string;
  origin: CaptureEvidenceSource;
  sourceUrl: string | undefined;
  observedAt: Date;
  retentionDays: number;
  /** attribute → value; empty values are skipped. */
  facts: Record<string, unknown>;
  reviewerId?: string;
  /** Overrides the origin's state for one write (an employer link read on a profile, say). */
  state?: EvidenceState;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)
  );
}

/**
 * Writes one evidence row per observed fact. Seeing the same value again from the same source
 * refreshes that row (retrieved time, freshness, corroboration count) instead of adding a
 * duplicate, so the ledger grows with what changed, not with how often a page was captured.
 */
export async function recordObservedFacts(db: Executor, input: ObservedFactsInput): Promise<{ written: number; refreshed: number }> {
  const origin = CAPTURE_EVIDENCE_SOURCES[input.origin];
  const facts = Object.entries(input.facts).filter(([, value]) => !isEmpty(value));
  if (!facts.length) return { written: 0, refreshed: 0 };

  const latest = await db
    .selectDistinctOn([evidenceLedger.attribute], {
      id: evidenceLedger.id,
      attribute: evidenceLedger.attribute,
      value: evidenceLedger.value,
    })
    .from(evidenceLedger)
    .where(
      and(
        eq(evidenceLedger.workspaceId, input.workspaceId),
        eq(evidenceLedger.entityType, input.entityType),
        eq(evidenceLedger.entityId, input.entityId),
        eq(evidenceLedger.source, origin.source),
        inArray(evidenceLedger.attribute, facts.map(([attribute]) => attribute))
      )
    )
    .orderBy(evidenceLedger.attribute, sql`${evidenceLedger.observedAt} desc`);
  const previous = new Map(latest.map((row) => [row.attribute, row]));

  const state = input.state ?? origin.state;
  const now = new Date();
  const freshnessExpiresAt = new Date(input.observedAt.getTime() + EVIDENCE_POLICY.FRESHNESS_DAYS * DAY_MS);
  const retentionUntil = new Date(now.getTime() + input.retentionDays * DAY_MS);

  const refreshIds: string[] = [];
  const inserts: (typeof evidenceLedger.$inferInsert)[] = [];
  for (const [attribute, value] of facts) {
    const known = previous.get(attribute);
    if (known && hashValue(known.value) === hashValue(value)) {
      refreshIds.push(known.id);
      continue;
    }
    const inferred = INFERRED_ATTRIBUTES.has(attribute);
    inserts.push({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      attribute,
      value: value as object,
      source: origin.source,
      sourceUrl: input.sourceUrl,
      observedAt: input.observedAt,
      retrievedAt: now,
      method: input.origin === "manual" ? "manual_entry" : inferred ? EVIDENCE_POLICY.inferredMethod : EVIDENCE_POLICY.method,
      confidence: inferred ? Math.min(origin.confidence, EVIDENCE_POLICY.inferredConfidence) : origin.confidence,
      validation: state,
      authority: state === "verified" ? "subject_page" : "search_result",
      freshnessExpiresAt,
      permittedPurpose: EVIDENCE_POLICY.permittedPurpose,
      consentBasis: EVIDENCE_POLICY.consentBasis,
      retentionUntil,
      reviewerId: input.reviewerId,
    });
  }

  if (refreshIds.length) {
    await db
      .update(evidenceLedger)
      .set({
        retrievedAt: now,
        observedAt: input.observedAt,
        sourceUrl: input.sourceUrl,
        validation: state,
        freshnessExpiresAt,
        retentionUntil,
        corroborationCount: sql`${evidenceLedger.corroborationCount} + 1`,
      })
      .where(and(eq(evidenceLedger.workspaceId, input.workspaceId), inArray(evidenceLedger.id, refreshIds)));
  }
  if (inserts.length) await db.insert(evidenceLedger).values(inserts);
  return { written: inserts.length, refreshed: refreshIds.length };
}

/** Removes every capture-derived evidence row for a record that is being deleted. */
export async function deleteCaptureEvidence(
  db: Executor,
  workspaceId: string,
  entityType: "prospect" | "company" | "contact",
  entityIds: string[]
): Promise<number> {
  if (!entityIds.length) return 0;
  const removed = await db
    .delete(evidenceLedger)
    .where(
      and(
        eq(evidenceLedger.workspaceId, workspaceId),
        eq(evidenceLedger.entityType, entityType),
        inArray(evidenceLedger.entityId, entityIds),
        // A contact's CRM provenance (manual edits, other providers) is not capture-derived.
        ...(entityType === "contact" ? [inArray(evidenceLedger.source, CAPTURE_DERIVED_SOURCES)] : [])
      )
    )
    .returning({ id: evidenceLedger.id });
  return removed.length;
}

/** Retention sweep: capture-derived evidence past its `retention_until` is removed. */
export async function purgeExpiredCaptureEvidence(db: Executor, now = new Date()): Promise<number> {
  const removed = await db
    .delete(evidenceLedger)
    .where(
      and(
        isNotNull(evidenceLedger.retentionUntil),
        lt(evidenceLedger.retentionUntil, now),
        inArray(evidenceLedger.source, CAPTURE_DERIVED_SOURCES)
      )
    )
    .returning({ id: evidenceLedger.id });
  return removed.length;
}
