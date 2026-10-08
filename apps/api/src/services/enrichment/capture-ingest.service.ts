/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-02 capture ingest (extension → workspace CRM).
 *   - Tables touched directly: contacts, companies (both owned by apps/crm)
 *     - read AND write
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a reviewed capture must resolve canonical LinkedIn identity, upsert the CRM
 *     contact/company and write its capture run counters in one transaction per record;
 *     same boundary as ENR-01's prospect↔CRM linkage (prospect-crm-link.service.ts).
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { generateCompanyId, normalizeDomain } from "@skout/shared";
import { recordPrivilegedAction } from "@skout/auth";
import { buildEntitlementsService } from "../entitlements.service.js";
import { proposeMerge } from "../identity-merge.service.js";
import { readRetentionDays, recordObservedFacts, type CaptureEvidenceSource, type EvidenceState } from "./capture-evidence.js";
import {
  canonicalPublicProfileUrl,
  companyIdFromCompanyUrl,
  companyMatchScore,
  companyMemberKey,
  companyPublicKey,
  currentEmployerSignature,
  domainFromCompany,
  hashRecord,
  isSameCompany,
  mergeCompanyCapture,
  normalizedCompanyName,
  personPublicKey,
  prospectIdForCanonicalKey,
  publicIdFromProfileUrl,
  salesLeadIdFromUrl,
  salesLeadKey,
} from "./capture-identity.js";
import {
  CAPTURE_CAPS,
  isUsableCardName,
  sanitizePersonCapture,
  type CaptureRunKind,
  type CompanyIngestInput,
  type PersonIngestInput,
  type SalesSearchIngestInput,
} from "./capture-schemas.js";

const log = createLogger("capture-ingest");
const {
  companies,
  contacts,
  prospectActivations,
  listMembers,
  lists,
  companyPersonDiscoveries,
  enrichmentSnapshots,
  enrichmentChangeEvents,
  enrichmentIdentities,
  enrichmentCaptureRuns,
  evidenceLedger,
  identityMergeEvents,
  identityMergeProposals,
} = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Json = Record<string, unknown>;
export type CaptureRun = typeof enrichmentCaptureRuns.$inferSelect;

export const KILL_SWITCH_ENTITLEMENT = "enrichment.capture_kill_switch";
export const DAILY_LIMIT_ENTITLEMENT = "enrichment.capture_daily_lead_limit";
const TERMINAL_STATUSES = new Set(["completed", "stopped", "failed", "halted", "rejected"]);
/** A run the browser never finished (tab closed, extension reloaded) is not left "running". */
const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

export class CaptureError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly run?: CaptureRun
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface CaptureActor {
  workspaceId: string;
  userId: string;
}

export interface CaptureStatus {
  enabled: boolean;
  disabledReason: string | null;
  caps: { maxPagesPerRun: number; maxLeadsPerRun: number; dailyLeadLimit: number };
  usage: { leadsToday: number; remainingToday: number };
}

export interface IngestOutcome {
  run: CaptureRun;
  received: number;
  created: number;
  merged: number;
  rejected: number;
  rejectedFields?: string[];
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ── Kill switch, caps and daily limits ────────────────────────────────────────

/** Read straight from the database on every call so a flipped switch applies to the next request. */
async function readKillSwitch(db: Db, workspaceId: string): Promise<{ disabled: boolean; reason: string | null }> {
  const row = await buildEntitlementsService(db)!.get(workspaceId, KILL_SWITCH_ENTITLEMENT);
  const value = row?.value as { disabled?: unknown; reason?: unknown } | null | undefined;
  return {
    disabled: value?.disabled === true,
    reason: typeof value?.reason === "string" && value.reason ? value.reason : null,
  };
}

/** For capture paths outside the ingest routes: refuses LinkedIn-sourced writes while the switch is on. */
export async function assertCaptureEnabled(db: Db, workspaceId: string): Promise<void> {
  const killSwitch = await readKillSwitch(db, workspaceId);
  if (killSwitch.disabled) {
    throw new CaptureError("capture_disabled", 403, killSwitch.reason ?? "Capture is disabled for this workspace.");
  }
}

async function readDailyLimit(db: Db, workspaceId: string): Promise<number> {
  const row = await buildEntitlementsService(db)!.get(workspaceId, DAILY_LIMIT_ENTITLEMENT);
  const value = row?.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : CAPTURE_CAPS.DEFAULT_DAILY_LEADS_PER_USER;
}

async function leadsCapturedToday(db: Db, actor: CaptureActor): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${enrichmentCaptureRuns.leadsReceived} - ${enrichmentCaptureRuns.leadsRejected}), 0)::int`,
    })
    .from(enrichmentCaptureRuns)
    .where(
      and(
        eq(enrichmentCaptureRuns.workspaceId, actor.workspaceId),
        eq(enrichmentCaptureRuns.userId, actor.userId),
        gte(enrichmentCaptureRuns.startedAt, startOfUtcDay())
      )
    );
  return row?.total ?? 0;
}

export async function getCaptureStatus(db: Db, actor: CaptureActor): Promise<CaptureStatus> {
  const [killSwitch, dailyLeadLimit, leadsToday] = await Promise.all([
    readKillSwitch(db, actor.workspaceId),
    readDailyLimit(db, actor.workspaceId),
    leadsCapturedToday(db, actor),
  ]);
  return {
    enabled: !killSwitch.disabled,
    disabledReason: killSwitch.disabled ? killSwitch.reason : null,
    caps: {
      maxPagesPerRun: CAPTURE_CAPS.MAX_PAGES_PER_RUN,
      maxLeadsPerRun: CAPTURE_CAPS.MAX_LEADS_PER_RUN,
      dailyLeadLimit,
    },
    usage: { leadsToday, remainingToday: Math.max(0, dailyLeadLimit - leadsToday) },
  };
}

export async function updateCaptureSettings(
  db: Db,
  actor: CaptureActor,
  input: { enabled?: boolean; reason?: string; dailyLeadLimit?: number }
): Promise<CaptureStatus> {
  const entitlements = buildEntitlementsService(db)!;
  const before = await getCaptureStatus(db, actor);
  if (input.enabled !== undefined) {
    await entitlements.set(
      actor.workspaceId,
      KILL_SWITCH_ENTITLEMENT,
      {
        disabled: !input.enabled,
        reason: input.enabled ? null : (input.reason ?? null),
        updatedBy: actor.userId,
        updatedAt: new Date().toISOString(),
      },
      "enrichment_admin"
    );
  }
  if (input.dailyLeadLimit !== undefined) {
    await entitlements.set(actor.workspaceId, DAILY_LIMIT_ENTITLEMENT, input.dailyLeadLimit, "enrichment_admin");
  }
  const after = await getCaptureStatus(db, actor);
  await recordPrivilegedAction(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: "enrichment.capture_settings.update",
    entityType: "workspace",
    entityId: actor.workspaceId,
    beforeState: { enabled: before.enabled, dailyLeadLimit: before.caps.dailyLeadLimit },
    afterState: { enabled: after.enabled, dailyLeadLimit: after.caps.dailyLeadLimit, reason: after.disabledReason },
  });
  return after;
}

// ── Capture runs ──────────────────────────────────────────────────────────────

async function closeRun(
  db: Db,
  run: CaptureRun,
  status: CaptureRun["status"],
  error?: { code: string; message: string }
): Promise<CaptureRun> {
  const [updated] = await db
    .update(enrichmentCaptureRuns)
    .set({
      status,
      errorCode: error?.code ?? null,
      errorMessage: error?.message?.slice(0, 500) ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(enrichmentCaptureRuns.id, run.id), eq(enrichmentCaptureRuns.status, "running")))
    .returning();
  if (updated) return updated;
  // Another request already recorded a terminal state; report that one.
  const [current] = await db.select().from(enrichmentCaptureRuns).where(eq(enrichmentCaptureRuns.id, run.id)).limit(1);
  return current ?? run;
}

async function insertRun(
  db: Db,
  actor: CaptureActor,
  values: { kind: CaptureRunKind; sourceUrl?: string; clientRunId?: string; status?: CaptureRun["status"]; error?: { code: string; message: string } }
): Promise<CaptureRun> {
  const terminal = values.status && values.status !== "running";
  const [run] = await db
    .insert(enrichmentCaptureRuns)
    .values({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      kind: values.kind,
      sourceUrl: values.sourceUrl?.slice(0, 2_000),
      clientRunId: values.clientRunId,
      status: values.status ?? "running",
      errorCode: values.error?.code,
      errorMessage: values.error?.message,
      completedAt: terminal ? new Date() : null,
    })
    .returning();
  return run!;
}

export async function startCaptureRun(
  db: Db,
  actor: CaptureActor,
  input: { kind: CaptureRunKind; sourceUrl?: string; clientRunId?: string }
): Promise<CaptureRun> {
  if (input.clientRunId) {
    const [existing] = await db
      .select()
      .from(enrichmentCaptureRuns)
      .where(
        and(
          eq(enrichmentCaptureRuns.workspaceId, actor.workspaceId),
          eq(enrichmentCaptureRuns.userId, actor.userId),
          eq(enrichmentCaptureRuns.clientRunId, input.clientRunId)
        )
      )
      .limit(1);
    if (existing) return existing;
  }

  const killSwitch = await readKillSwitch(db, actor.workspaceId);
  if (killSwitch.disabled) {
    const error = { code: "capture_disabled", message: killSwitch.reason ?? "Capture is disabled for this workspace." };
    // Recorded (without a client id, so a later retry is evaluated again) for the admin's run log.
    const run = await insertRun(db, actor, { ...input, clientRunId: undefined, status: "rejected", error });
    throw new CaptureError(error.code, 403, error.message, run);
  }

  const [limit, used] = await Promise.all([readDailyLimit(db, actor.workspaceId), leadsCapturedToday(db, actor)]);
  if (used >= limit) {
    const error = { code: "daily_limit_reached", message: `Daily capture limit of ${limit} leads reached.` };
    const run = await insertRun(db, actor, { ...input, clientRunId: undefined, status: "rejected", error });
    throw new CaptureError(error.code, 429, error.message, run);
  }

  return insertRun(db, actor, input);
}

async function loadRun(db: Db, actor: CaptureActor, runId: string): Promise<CaptureRun> {
  const [run] = await db
    .select()
    .from(enrichmentCaptureRuns)
    .where(and(eq(enrichmentCaptureRuns.id, runId), eq(enrichmentCaptureRuns.workspaceId, actor.workspaceId)))
    .limit(1);
  // Another member's run is reported exactly like a missing one.
  if (!run || run.userId !== actor.userId) throw new CaptureError("run_not_found", 404, "Capture run not found.");
  return run;
}

export async function getCaptureRun(db: Db, workspaceId: string, runId: string): Promise<CaptureRun | null> {
  const [run] = await db
    .select()
    .from(enrichmentCaptureRuns)
    .where(and(eq(enrichmentCaptureRuns.id, runId), eq(enrichmentCaptureRuns.workspaceId, workspaceId)))
    .limit(1);
  return run ?? null;
}

export async function listCaptureRuns(db: Db, workspaceId: string, limit = 50): Promise<CaptureRun[]> {
  await db
    .update(enrichmentCaptureRuns)
    .set({
      status: "failed",
      errorCode: "abandoned",
      errorMessage: "The capture was interrupted before it reported a result.",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(enrichmentCaptureRuns.workspaceId, workspaceId),
        eq(enrichmentCaptureRuns.status, "running"),
        lt(enrichmentCaptureRuns.updatedAt, new Date(Date.now() - ABANDONED_AFTER_MS))
      )
    );
  return db
    .select()
    .from(enrichmentCaptureRuns)
    .where(eq(enrichmentCaptureRuns.workspaceId, workspaceId))
    .orderBy(desc(enrichmentCaptureRuns.startedAt))
    .limit(limit);
}

export async function finishCaptureRun(
  db: Db,
  actor: CaptureActor,
  runId: string,
  input: { status: "completed" | "stopped" | "failed"; reason?: string }
): Promise<CaptureRun> {
  const run = await loadRun(db, actor, runId);
  if (TERMINAL_STATUSES.has(run.status)) return run;
  const finished = await closeRun(
    db,
    run,
    input.status,
    input.status === "completed" ? undefined : { code: input.status === "stopped" ? "stopped" : "client_failure", message: input.reason ?? "" }
  );
  await auditRun(db, actor, finished);
  return finished;
}

async function auditRun(db: Db, actor: CaptureActor, run: CaptureRun): Promise<void> {
  await recordPrivilegedAction(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: "enrichment.capture",
    entityType: "capture_run",
    entityId: run.id,
    afterState: {
      kind: run.kind,
      status: run.status,
      pagesRead: run.pagesRead,
      leadsReceived: run.leadsReceived,
      leadsCreated: run.leadsCreated,
      leadsMerged: run.leadsMerged,
      leadsRejected: run.leadsRejected,
      errorCode: run.errorCode,
    },
  });
}

/**
 * Admission check before any record of a request is written. The kill switch is evaluated
 * first, on every request, and ends the run: nothing further is accepted for it.
 */
async function admit(db: Db, actor: CaptureActor, run: CaptureRun, leads: number, pages: number): Promise<void> {
  if (run.status !== "running") {
    throw new CaptureError("run_not_active", 409, `Capture run is already ${run.status}.`, run);
  }
  const killSwitch = await readKillSwitch(db, actor.workspaceId);
  if (killSwitch.disabled) {
    const error = { code: "capture_disabled", message: killSwitch.reason ?? "Capture is disabled for this workspace." };
    const halted = await closeRun(db, run, "halted", error);
    await auditRun(db, actor, halted);
    throw new CaptureError(error.code, 403, error.message, halted);
  }
  if (run.leadsReceived + leads > CAPTURE_CAPS.MAX_LEADS_PER_RUN) {
    throw new CaptureError(
      "lead_cap_exceeded",
      422,
      `A capture run accepts at most ${CAPTURE_CAPS.MAX_LEADS_PER_RUN} leads.`,
      run
    );
  }
  if (run.pagesRead + pages > CAPTURE_CAPS.MAX_PAGES_PER_RUN) {
    throw new CaptureError(
      "page_cap_exceeded",
      422,
      `A capture run reads at most ${CAPTURE_CAPS.MAX_PAGES_PER_RUN} result pages.`,
      run
    );
  }
  const [limit, used] = await Promise.all([readDailyLimit(db, actor.workspaceId), leadsCapturedToday(db, actor)]);
  if (used + leads > limit) {
    throw new CaptureError(
      "daily_limit_reached",
      429,
      `Daily capture limit of ${limit} leads reached (${Math.max(0, limit - used)} remaining today).`,
      run
    );
  }
}

interface BatchCounts {
  received: number;
  created: number;
  merged: number;
  rejected: number;
  pages: number;
}

/**
 * Runs one ingest request inside a capture run. Without a `runId` the request is its own
 * run and the response already carries its terminal status.
 */
async function withRun(
  db: Db,
  actor: CaptureActor,
  request: { runId?: string; kind: CaptureRunKind; sourceUrl: string; leads: number; pages: number },
  work: (run: CaptureRun) => Promise<Omit<BatchCounts, "pages"> & { rejectedFields?: string[] }>
): Promise<IngestOutcome> {
  const standalone = !request.runId;
  const run = request.runId
    ? await loadRun(db, actor, request.runId)
    : await startCaptureRun(db, actor, { kind: request.kind, sourceUrl: request.sourceUrl });
  if (run.kind !== request.kind) {
    throw new CaptureError("run_kind_mismatch", 409, `Capture run is a ${run.kind} run.`, run);
  }

  try {
    await admit(db, actor, run, request.leads, request.pages);
  } catch (error) {
    if (standalone && error instanceof CaptureError && error.run?.status === "running") {
      const rejected = await closeRun(db, run, "rejected", { code: error.code, message: error.message });
      throw new CaptureError(error.code, error.statusCode, error.message, rejected);
    }
    throw error;
  }

  let counts: Awaited<ReturnType<typeof work>>;
  try {
    counts = await work(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("capture ingest failed", error, { workspaceId: actor.workspaceId, runId: run.id });
    const failed = await closeRun(db, run, "failed", { code: "ingest_failed", message });
    await auditRun(db, actor, failed);
    throw new CaptureError("ingest_failed", 500, "The capture could not be saved.", failed);
  }

  const [updated] = await db
    .update(enrichmentCaptureRuns)
    .set({
      pagesRead: sql`${enrichmentCaptureRuns.pagesRead} + ${request.pages}`,
      leadsReceived: sql`${enrichmentCaptureRuns.leadsReceived} + ${counts.received}`,
      leadsCreated: sql`${enrichmentCaptureRuns.leadsCreated} + ${counts.created}`,
      leadsMerged: sql`${enrichmentCaptureRuns.leadsMerged} + ${counts.merged}`,
      leadsRejected: sql`${enrichmentCaptureRuns.leadsRejected} + ${counts.rejected}`,
      updatedAt: new Date(),
    })
    .where(eq(enrichmentCaptureRuns.id, run.id))
    .returning();

  let finalRun = updated ?? run;
  if (standalone) {
    finalRun = await closeRun(db, finalRun, "completed");
    await auditRun(db, actor, finalRun);
  }
  return { run: finalRun, ...counts };
}

// ── Identity resolution and record upserts ────────────────────────────────────

async function lockKeys(tx: Tx, workspaceId: string, entityType: "person" | "company", keys: string[]): Promise<void> {
  // Serializes concurrent captures of the same identity; sorted so two requests never deadlock.
  for (const key of [...keys].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${entityType}:${key}`}, 0))`);
  }
}

async function identityTargets(
  tx: Tx,
  workspaceId: string,
  entityType: "person" | "company",
  keys: string[]
): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = await tx
    .select({ key: enrichmentIdentities.canonicalKey, entityId: enrichmentIdentities.entityId })
    .from(enrichmentIdentities)
    .where(
      and(
        eq(enrichmentIdentities.workspaceId, workspaceId),
        eq(enrichmentIdentities.entityType, entityType),
        inArray(enrichmentIdentities.canonicalKey, keys)
      )
    );
  return new Map(rows.map((row) => [row.key, row.entityId]));
}

async function pointIdentities(
  tx: Tx,
  workspaceId: string,
  entityType: "person" | "company",
  keys: string[],
  entityId: string
): Promise<void> {
  if (!keys.length) return;
  await tx
    .insert(enrichmentIdentities)
    .values(keys.map((canonicalKey) => ({ workspaceId, entityType, canonicalKey, entityId })))
    .onConflictDoUpdate({
      target: [enrichmentIdentities.workspaceId, enrichmentIdentities.entityType, enrichmentIdentities.canonicalKey],
      set: { entityId },
    });
}

function isManual(fieldSources: unknown, field: string): boolean {
  const entry = (fieldSources as Record<string, { source?: string } | undefined> | null)?.[field];
  return entry?.source === "manual";
}

function splitName(fullName: string | undefined): { firstName: string; lastName: string | null } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "Unknown", lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

function captureDomain(companyName: string | undefined): string {
  const slug = (companyName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  // Same placeholder convention as the extension's existing add-to-list flow.
  return slug ? `${slug}.linkedin` : "linkedin-capture.local";
}

async function writeSnapshot(
  tx: Tx,
  actor: CaptureActor,
  entityType: "person" | "company",
  entityId: string,
  rawData: Json
): Promise<number> {
  const data = Object.fromEntries(Object.entries(rawData).filter(([, value]) => value !== undefined && value !== null));
  const fieldHashes = hashRecord(data);
  const [previous] = await tx
    .select()
    .from(enrichmentSnapshots)
    .where(
      and(
        eq(enrichmentSnapshots.workspaceId, actor.workspaceId),
        eq(enrichmentSnapshots.entityType, entityType),
        eq(enrichmentSnapshots.entityId, entityId)
      )
    )
    .orderBy(desc(enrichmentSnapshots.capturedAt))
    .limit(1);

  const oldHashes = (previous?.fieldHashes ?? {}) as Record<string, string>;
  const oldData = (previous?.rawData ?? {}) as Json;
  // Bookkeeping fields change on every capture and are not profile changes.
  const ignored = new Set(["capturedAt", "sourceUrl", "captureSource"]);
  const changes = previous
    ? Object.entries(data)
        .filter(([field]) => !ignored.has(field) && oldHashes[field] !== fieldHashes[field])
        .map(([field, newValue]) => ({
          workspaceId: actor.workspaceId,
          entityType,
          entityId,
          field,
          changeType: Object.hasOwn(oldHashes, field) ? ("FIELD_UPDATED" as const) : ("FIELD_ADDED" as const),
          oldValue: oldData[field] ?? null,
          newValue,
          // A job change is a change of current employer or role, not any edit near it.
          isJobChange:
            entityType === "person" &&
            field === "currentCompanies" &&
            currentEmployerSignature(oldData[field]) !== currentEmployerSignature(newValue),
        }))
    : [];
  // An identical re-capture is recorded once, not as a new history entry.
  if (previous && changes.length === 0) return 0;

  await tx.insert(enrichmentSnapshots).values({
    workspaceId: actor.workspaceId,
    entityType,
    entityId,
    fieldHashes,
    rawData: data,
    capturedVia: "EXTENSION",
    capturedBy: actor.userId,
  });
  if (changes.length) await tx.insert(enrichmentChangeEvents).values(changes);
  return changes.length;
}

async function linkDiscovery(tx: Tx, workspaceId: string, companyId: string, contactId: string, source: string) {
  await tx
    .insert(companyPersonDiscoveries)
    .values({ workspaceId, companyId, contactId, source })
    .onConflictDoUpdate({
      target: [companyPersonDiscoveries.workspaceId, companyPersonDiscoveries.companyId, companyPersonDiscoveries.contactId],
      set: { source, capturedAt: new Date() },
    });
}

type ContactRow = typeof contacts.$inferSelect;

async function liveContacts(tx: Tx, workspaceId: string, ids: string[]): Promise<ContactRow[]> {
  if (!ids.length) return [];
  return tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, ids), isNull(contacts.deletedAt)));
}

/** A contact added through the older add-to-list flow carries the public URL but no identity row. */
async function contactByPublicUrl(tx: Tx, workspaceId: string, publicId: string): Promise<ContactRow | undefined> {
  const suffix = `linkedin.com/in/${publicId}`;
  const [row] = await tx
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        isNull(contacts.deletedAt),
        sql`right(lower(rtrim(split_part(split_part(${contacts.linkedinUrl}, '?', 1), '#', 1), '/')), ${suffix.length}::int) = ${suffix}`
      )
    )
    .orderBy(contacts.createdAt)
    .limit(1);
  return row;
}

/** Folds a Sales-lead-only record into the public-profile record for the same person. */
async function mergeLeadIntoPublic(
  tx: Tx,
  actor: CaptureActor,
  lead: ContactRow,
  target: ContactRow,
  reason: "public_url_visible" | "public_url_attached"
): Promise<void> {
  const { workspaceId } = actor;
  // Reversible bookkeeping, same trail the reviewed CRM merges use (identity-merge.service.ts).
  await tx.insert(identityMergeEvents).values({
    workspaceId,
    entityType: "contact",
    action: "merge",
    primaryEntityId: target.id,
    mergedEntityId: lead.id,
    beforeSnapshot: JSON.parse(JSON.stringify({ reason, primary: target, merged: lead })) as object,
    performedBy: actor.userId,
  });
  const discoveries = await tx
    .select()
    .from(companyPersonDiscoveries)
    .where(and(eq(companyPersonDiscoveries.workspaceId, workspaceId), eq(companyPersonDiscoveries.contactId, lead.id)));
  for (const item of discoveries) {
    await tx
      .insert(companyPersonDiscoveries)
      .values({ workspaceId, companyId: item.companyId, contactId: target.id, source: item.source, capturedAt: item.capturedAt })
      .onConflictDoNothing();
  }
  await tx
    .delete(companyPersonDiscoveries)
    .where(and(eq(companyPersonDiscoveries.workspaceId, workspaceId), eq(companyPersonDiscoveries.contactId, lead.id)));
  await tx
    .update(enrichmentIdentities)
    .set({ entityId: target.id })
    .where(
      and(
        eq(enrichmentIdentities.workspaceId, workspaceId),
        eq(enrichmentIdentities.entityType, "person"),
        eq(enrichmentIdentities.entityId, lead.id)
      )
    );

  const from = lead.sourceProspectId;
  const to = target.sourceProspectId;
  if (from && to && from !== to) {
    await tx
      .update(enrichmentSnapshots)
      .set({ entityId: to })
      .where(
        and(
          eq(enrichmentSnapshots.workspaceId, workspaceId),
          eq(enrichmentSnapshots.entityType, "person"),
          eq(enrichmentSnapshots.entityId, from)
        )
      );
    await tx
      .update(enrichmentChangeEvents)
      .set({ entityId: to })
      .where(
        and(
          eq(enrichmentChangeEvents.workspaceId, workspaceId),
          eq(enrichmentChangeEvents.entityType, "person"),
          eq(enrichmentChangeEvents.entityId, from)
        )
      );
    await tx
      .update(evidenceLedger)
      .set({ entityId: to })
      .where(
        and(eq(evidenceLedger.workspaceId, workspaceId), eq(evidenceLedger.entityType, "prospect"), eq(evidenceLedger.entityId, from))
      );
    const workspaceLists = await tx.select({ id: lists.id }).from(lists).where(eq(lists.workspaceId, workspaceId));
    if (workspaceLists.length) {
      const listIds = workspaceLists.map((list) => list.id);
      const memberships = await tx
        .select({ listId: listMembers.listId })
        .from(listMembers)
        .where(and(inArray(listMembers.listId, listIds), eq(listMembers.prospectId, from)));
      for (const membership of memberships) {
        await tx.insert(listMembers).values({ listId: membership.listId, prospectId: to }).onConflictDoNothing();
      }
      await tx.delete(listMembers).where(and(inArray(listMembers.listId, listIds), eq(listMembers.prospectId, from)));
    }
    const activations = await tx
      .select({ prospectId: prospectActivations.prospectId, snapshot: prospectActivations.snapshot })
      .from(prospectActivations)
      .where(and(eq(prospectActivations.workspaceId, workspaceId), inArray(prospectActivations.prospectId, [from, to])));
    const leadSnapshot = (activations.find((row) => row.prospectId === from)?.snapshot ?? {}) as Json;
    const targetSnapshot = activations.find((row) => row.prospectId === to)?.snapshot as Json | undefined;
    if (targetSnapshot) {
      // The public-profile record wins; the lead only fills what it lacks (its Sales lead URL, say).
      const { prospectId: _leadProspectId, companyId: _leadCompanyId, ...leadFacts } = leadSnapshot;
      await tx
        .update(prospectActivations)
        .set({ snapshot: { ...leadFacts, ...targetSnapshot }, updatedAt: new Date() })
        .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, to)));
    }
    await tx
      .delete(prospectActivations)
      .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, from)));
  }
  await tx
    .update(contacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, lead.id)));
}

interface PersonRecordInput {
  /** `profile`: the person's own public page. `card`: a search/discovery card (thinner evidence). */
  mode: "profile" | "card";
  publicId?: string;
  salesLeadId?: string;
  salesLeadUrl?: string;
  fullName?: string;
  headline?: string;
  title?: string;
  companyName?: string;
  companyDomain?: string;
  companyId?: string | null;
  discoverySource: string;
  /** Capture-only fields kept on the activation snapshot. */
  facts: Json;
  /** True when the visible employer name matched more than one saved company. */
  employerAmbiguous?: boolean;
  evidence: { origin: CaptureEvidenceSource; sourceUrl: string | undefined; observedAt: Date; retentionDays: number; reviewerId?: string };
}

/** Profile facts written to the Evidence Ledger, one row per attribute. */
const PROFILE_EVIDENCE_ATTRIBUTES = [
  "fullName", "headline", "summary", "locationName", "locationCountry", "industry", "pronoun",
  "currentCompanies", "previousCompanies", "educations", "skills", "certifications", "languages",
  "recommendations", "volunteerExperiences", "honors", "publications", "patents", "courses",
  "organizations", "projects", "connectionsCount", "followersCount", "relationshipContext",
  "seniority", "jobFunction", "openToWork", "hiring",
] as const;
const CARD_EVIDENCE_ATTRIBUTES = ["fullName", "headline", "locationName", "currentCompanies"] as const;

async function upsertPersonRecord(
  tx: Tx,
  actor: CaptureActor,
  input: PersonRecordInput
): Promise<{ contactId: string; prospectId: string; created: boolean }> {
  const { workspaceId } = actor;
  const publicKey = input.publicId ? personPublicKey(input.publicId) : undefined;
  const leadKey = input.salesLeadId ? salesLeadKey(input.salesLeadId) : undefined;
  const keys = [publicKey, leadKey].filter((key): key is string => !!key);
  await lockKeys(tx, workspaceId, "person", keys);

  const targets = await identityTargets(tx, workspaceId, "person", keys);
  const known = await liveContacts(tx, workspaceId, [...new Set(targets.values())]);
  const byId = new Map(known.map((row) => [row.id, row]));
  let byPublic = publicKey ? byId.get(targets.get(publicKey) ?? "") : undefined;
  const byLead = leadKey ? byId.get(targets.get(leadKey) ?? "") : undefined;
  if (!byPublic && input.publicId) byPublic = await contactByPublicUrl(tx, workspaceId, input.publicId);

  let contact = byPublic ?? byLead;
  if (byPublic && byLead && byPublic.id !== byLead.id) {
    await mergeLeadIntoPublic(tx, actor, byLead, byPublic, "public_url_visible");
    contact = byPublic;
  }

  const publicUrl = input.publicId ? canonicalPublicProfileUrl(input.publicId) : undefined;
  const profile = input.mode === "profile";
  let created = false;
  let prospectId: string;

  if (!contact) {
    prospectId = prospectIdForCanonicalKey(keys[0]!);
    const { firstName, lastName } = splitName(input.fullName);
    const [row] = await tx
      .insert(contacts)
      .values({
        workspaceId,
        firstName,
        lastName,
        title: input.title,
        linkedinUrl: publicUrl,
        companyId: input.companyId ?? null,
        // Only the person's own profile verifies a current employer.
        employmentStatus: profile && input.companyId ? "verified_employment" : "discovery_candidate",
        sourceProspectId: prospectId,
        fieldSources: {},
      })
      .returning();
    contact = row!;
    created = true;
  } else {
    prospectId = contact.sourceProspectId ?? prospectIdForCanonicalKey(keys[0]!);
    const update: Partial<typeof contacts.$inferInsert> = {};
    const settable = (field: keyof ContactRow, value: unknown) =>
      value !== undefined && value !== null && value !== "" && !isManual(contact!.fieldSources, field) &&
      (profile || !contact![field]);
    if (!contact.sourceProspectId) update.sourceProspectId = prospectId;
    if (settable("title", input.title) && contact.title !== input.title) update.title = input.title;
    // A public URL replaces nothing but an empty or non-public value.
    if (publicUrl && !isManual(contact.fieldSources, "linkedinUrl") && !publicIdFromProfileUrl(contact.linkedinUrl ?? "")) {
      update.linkedinUrl = publicUrl;
    }
    if (settable("companyId", input.companyId) && contact.companyId !== input.companyId) update.companyId = input.companyId;
    if (profile && input.fullName && !isManual(contact.fieldSources, "firstName")) {
      const { firstName, lastName } = splitName(input.fullName);
      if (contact.firstName !== firstName || contact.lastName !== lastName) Object.assign(update, { firstName, lastName });
    }
    if (profile && input.companyId && contact.employmentStatus !== "verified_employment") {
      update.employmentStatus = "verified_employment";
    }
    if (Object.keys(update).length) {
      await tx
        .update(contacts)
        .set({ ...update, updatedAt: new Date() })
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contact.id)));
    }
  }

  await pointIdentities(tx, workspaceId, "person", keys, contact.id);

  const [activation] = await tx
    .select({ snapshot: prospectActivations.snapshot, companyId: prospectActivations.companyId })
    .from(prospectActivations)
    .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)))
    .limit(1);
  const existing = (activation?.snapshot ?? {}) as Json;
  const companyDomain = normalizeDomain(input.companyDomain ?? captureDomain(input.companyName));
  const incoming: Json = Object.fromEntries(
    Object.entries({
      ...input.facts,
      fullName: input.fullName,
      title: input.title,
      headline: input.headline,
      companyName: input.companyName,
      linkedinUrl: publicUrl,
      linkedinPublicId: input.publicId,
      salesNavigatorLeadUrl: input.salesLeadUrl,
    }).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  // A thinner search card never overwrites what a full profile capture already recorded.
  const snapshot: Json = profile ? { ...existing, ...incoming } : { ...incoming, ...existing };
  if (profile || !existing.companyDomain) snapshot.companyDomain = companyDomain;
  const context = { ...(existing.relationshipContext as Json | undefined), ...(input.facts.relationshipContext as Json | undefined) };
  if (Object.keys(context).length) snapshot.relationshipContext = context;
  if (publicUrl) snapshot.linkedinUrl = publicUrl;
  snapshot.prospectId = prospectId;
  const activationCompanyId = generateCompanyId(String(snapshot.companyDomain ?? companyDomain));
  snapshot.companyId = activationCompanyId;

  await tx
    .insert(prospectActivations)
    .values({ workspaceId, prospectId, companyId: activationCompanyId, snapshot })
    .onConflictDoUpdate({
      target: [prospectActivations.workspaceId, prospectActivations.prospectId],
      set: { snapshot, companyId: activationCompanyId, updatedAt: new Date() },
    });

  if (profile) await writeSnapshot(tx, actor, "person", prospectId, incoming);
  if (input.companyId) await linkDiscovery(tx, workspaceId, input.companyId, contact.id, input.discoverySource);

  const observed: Json = { ...input.facts, fullName: input.fullName, headline: input.headline };
  const attributes = profile ? PROFILE_EVIDENCE_ATTRIBUTES : CARD_EVIDENCE_ATTRIBUTES;
  const evidenceBase = {
    workspaceId,
    entityType: "prospect" as const,
    entityId: prospectId,
    origin: input.evidence.origin,
    sourceUrl: input.evidence.sourceUrl,
    observedAt: input.evidence.observedAt,
    retentionDays: input.evidence.retentionDays,
    reviewerId: input.evidence.reviewerId,
  };
  await recordObservedFacts(tx, {
    ...evidenceBase,
    facts: {
      ...Object.fromEntries(attributes.map((attribute) => [attribute, observed[attribute]])),
      linkedinUrl: publicUrl,
      salesNavigatorLeadUrl: input.salesLeadUrl,
    },
  });
  // Employment is its own fact: verified only when read on the person's own profile and
  // matched to a saved company; everything else is a discovery candidate.
  const employmentState: EvidenceState = profile && input.companyId ? "verified" : "discovery";
  if (input.companyName || input.companyId) {
    await recordObservedFacts(tx, {
      ...evidenceBase,
      state: employmentState,
      facts: {
        employment: {
          companyId: input.companyId ?? null,
          companyName: input.companyName ?? null,
          title: input.title ?? null,
          resolution: input.companyId ? "matched" : input.employerAmbiguous ? "ambiguous_company_name" : "no_saved_company",
        },
      },
    });
  }

  return { contactId: contact.id, prospectId, created };
}

type CompanyRow = typeof companies.$inferSelect;

async function companiesNamed(tx: Tx, workspaceId: string, companyName: string): Promise<CompanyRow[]> {
  const normalized = normalizedCompanyName(companyName);
  if (!normalized) return [];
  // Prefilter on the first word, then compare normalized names, so "Acme" and "Acme Inc." are
  // recognized as the same name (and therefore as ambiguous when both are saved).
  const firstWord = normalized.split(" ")[0]!.replace(/[\\%_]/g, "\\$&");
  const rows = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt), sql`${companies.name} ilike ${`%${firstWord}%`}`))
    .orderBy(companies.createdAt)
    .limit(200);
  return rows.filter((row) => normalizedCompanyName(row.name) === normalized).slice(0, 5);
}

async function companyByKeys(tx: Tx, workspaceId: string, keys: string[]): Promise<CompanyRow | undefined> {
  const targets = await identityTargets(tx, workspaceId, "company", keys);
  const ids = [...new Set(targets.values())];
  if (!ids.length) return undefined;
  const rows = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), inArray(companies.id, ids), isNull(companies.deletedAt)));
  return keys.map((key) => rows.find((row) => row.id === targets.get(key))).find(Boolean);
}

/**
 * Employer link for a person. A LinkedIn company id from the role's own link is decisive; a
 * name only links when exactly one saved company carries it. `createIfMissing` is reserved
 * for full profile captures: a search card never creates a company.
 */
async function resolveEmployer(
  tx: Tx,
  workspaceId: string,
  employer: { linkedinId?: string; name?: string },
  createIfMissing: boolean
): Promise<{ company: CompanyRow | null; ambiguous: boolean }> {
  const name = employer.name?.trim();
  // The role link may carry the vanity slug or the numeric member id.
  const keys = employer.linkedinId
    ? [companyPublicKey(employer.linkedinId), ...(/^\d+$/.test(employer.linkedinId) ? [companyMemberKey(employer.linkedinId)] : [])]
    : [];
  if (keys.length) await lockKeys(tx, workspaceId, "company", keys);
  const byKey = await companyByKeys(tx, workspaceId, keys);
  if (byKey) return { company: byKey, ambiguous: false };
  if (!name) return { company: null, ambiguous: false };

  const named = await companiesNamed(tx, workspaceId, name);
  if (named.length === 1) {
    await pointIdentities(tx, workspaceId, "company", keys, named[0]!.id);
    return { company: named[0]!, ambiguous: false };
  }
  // Several saved companies share this name: the link stays unresolved rather than guessed.
  if (named.length > 1) return { company: null, ambiguous: true };
  if (!createIfMissing) return { company: null, ambiguous: false };

  const [created] = await tx.insert(companies).values({ workspaceId, name, fieldSources: {} }).returning();
  await pointIdentities(tx, workspaceId, "company", keys, created!.id);
  return { company: created!, ambiguous: false };
}

// ── Ingest entry points ───────────────────────────────────────────────────────

export async function ingestPersonCapture(db: Db, actor: CaptureActor, input: PersonIngestInput): Promise<IngestOutcome & { person: { contactId: string; prospectId: string } | null }> {
  const { data, rejected: rejectedFields } = sanitizePersonCapture(input);
  if (!isUsableCardName(data.fullName)) {
    // The header was not readable, so nothing on the page can be attributed to this person.
    throw new CaptureError(
      "profile_not_readable",
      422,
      "The profile name was not readable. Reload the LinkedIn profile, wait for the header, then capture again."
    );
  }
  let person: { contactId: string; prospectId: string } | null = null;
  const outcome = await withRun(
    db,
    actor,
    { runId: input.runId, kind: "person", sourceUrl: input.sourceUrl, leads: 1, pages: 0 },
    async () => {
      const publicId = publicIdFromProfileUrl(data.sourceUrl)!;
      const role = data.currentCompanies?.[0] as { name?: unknown; title?: unknown } | undefined;
      const employerName = typeof role?.name === "string" ? role.name : undefined;
      const { runId: _runId, publicId: _publicId, sourceUrl, fullName, headline, ...facts } = data;

      const retentionDays = await readRetentionDays(db, actor.workspaceId);
      const observedAt = new Date(data.capturedAt ?? Date.now());
      const saved = await db.transaction(async (tx) => {
        const { company: employer, ambiguous } = await resolveEmployer(
          tx,
          actor.workspaceId,
          { linkedinId: data.currentCompanyPublicId, name: employerName },
          true
        );
        return upsertPersonRecord(tx, actor, {
          employerAmbiguous: ambiguous,
          evidence: { origin: "publicProfile", sourceUrl, observedAt, retentionDays },
          mode: "profile",
          publicId,
          fullName,
          headline,
          title: typeof role?.title === "string" ? role.title : undefined,
          companyName: employerName ?? employer?.name,
          companyDomain: employer?.domain ?? undefined,
          companyId: employer?.id ?? null,
          discoverySource: "linkedin_profile_capture",
          facts: {
            ...facts,
            location: facts.locationName,
            about: facts.summary,
            sourceUrl,
            captureSource: "linkedin-public-profile",
            capturedAt: observedAt.toISOString(),
          },
        });
      });
      person = { contactId: saved.contactId, prospectId: saved.prospectId };
      return { received: 1, created: saved.created ? 1 : 0, merged: saved.created ? 0 : 1, rejected: 0, rejectedFields };
    }
  );
  return { ...outcome, person };
}

export async function ingestSalesSearchCapture(db: Db, actor: CaptureActor, input: SalesSearchIngestInput): Promise<IngestOutcome> {
  return withRun(
    db,
    actor,
    { runId: input.runId, kind: "sales_search", sourceUrl: input.sourceUrl, leads: input.peopleProfiles.length, pages: input.pagesRead },
    async () => {
      const counts = { received: input.peopleProfiles.length, created: 0, merged: 0, rejected: 0 };
      const capturedAt = input.capturedAt ?? new Date().toISOString();
      const retentionDays = await readRetentionDays(db, actor.workspaceId);
      for (const profile of input.peopleProfiles) {
        if (!isUsableCardName(profile.fullName)) {
          counts.rejected++;
          continue;
        }
        const publicId = publicIdFromProfileUrl(profile.sourceUrl);
        const leadUrl = profile.relationshipContext?.salesNavigatorLeadUrl;
        const role = profile.currentCompanies?.[0];
        const saved = await db.transaction(async (tx) => {
          // Discovery evidence only: associate when the visible company identifies one saved company.
          const { company: employer, ambiguous } = role?.name
            ? await resolveEmployer(tx, actor.workspaceId, { linkedinId: role.companyPublicId, name: role.name }, false)
            : { company: null, ambiguous: false };
          return upsertPersonRecord(tx, actor, {
            employerAmbiguous: ambiguous,
            // The search the user ran is where the card was seen.
            evidence: { origin: "salesSearchCard", sourceUrl: input.sourceUrl, observedAt: new Date(capturedAt), retentionDays },
            mode: "card",
            publicId,
            salesLeadId: leadUrl ? salesLeadIdFromUrl(leadUrl) : undefined,
            salesLeadUrl: leadUrl,
            fullName: profile.fullName,
            headline: profile.headline,
            title: role?.title,
            companyName: role?.name,
            companyDomain: employer?.domain ?? undefined,
            companyId: employer?.id ?? null,
            discoverySource: "sales-navigator-search-result",
            facts: {
              location: profile.locationName,
              locationName: profile.locationName,
              currentCompanies: profile.currentCompanies,
              relationshipContext: profile.relationshipContext,
              sourceUrl: profile.sourceUrl,
              captureSource: "sales-navigator-search-result",
              capturedAt,
            },
          });
        });
        if (saved.created) counts.created++;
        else counts.merged++;
      }
      return counts;
    }
  );
}

function isCompanyStub(company: CompanyRow): boolean {
  return !company.domain && !company.industry && !company.location && company.employeeCount === null;
}

export async function ingestCompanyCapture(
  db: Db,
  actor: CaptureActor,
  input: CompanyIngestInput
): Promise<IngestOutcome & { company: { id: string; created: boolean } | null }> {
  const people = input.peopleProfiles ?? [];
  let companyResult: { id: string; created: boolean } | null = null;
  const outcome = await withRun(
    db,
    actor,
    { runId: input.runId, kind: "company", sourceUrl: input.sourceUrl, leads: people.length, pages: input.pagesRead ?? 0 },
    async () => {
      const { runId: _runId, peopleProfiles: _people, pagesRead: _pages, ...capture } = input;
      const domain = domainFromCompany(capture);
      const retentionDays = await readRetentionDays(db, actor.workspaceId);
      const observedAt = new Date(capture.capturedAt ?? Date.now());
      const keys = [companyPublicKey(capture.publicId), ...(capture.memberId ? [companyMemberKey(capture.memberId)] : [])];

      const company = await db.transaction(async (tx) => {
        await lockKeys(tx, actor.workspaceId, "company", keys);
        let stored = await companyByKeys(tx, actor.workspaceId, keys);
        if (!stored) {
          const candidates = [
            ...(domain
              ? await tx
                  .select()
                  .from(companies)
                  .where(and(eq(companies.workspaceId, actor.workspaceId), isNull(companies.deletedAt), eq(companies.domain, domain)))
                  .limit(5)
              : []),
            ...(capture.name ? await companiesNamed(tx, actor.workspaceId, capture.name) : []),
          ];
          const distinct = [...new Map(candidates.map((row) => [row.id, row])).values()];
          const incoming = { ...capture, domain };
          const like = (row: CompanyRow) => ({ name: row.name, domain: row.domain, industry: row.industry, headquarter: row.location });
          stored = distinct
            .filter((row) => isSameCompany(like(row), incoming))
            .sort((a, b) => companyMatchScore(like(b), incoming) - companyMatchScore(like(a), incoming))[0];
          // A name-only placeholder created from a person capture is this company when it is the only one.
          if (!stored) {
            const stubs = distinct.filter(isCompanyStub);
            if (stubs.length === 1 && distinct.length === 1) stored = stubs[0];
          }
        }

        let created = false;
        if (!stored) {
          const [row] = await tx
            .insert(companies)
            .values({
              workspaceId: actor.workspaceId,
              name: capture.name ?? capture.publicId,
              domain,
              industry: capture.industry,
              employeeCount: capture.employeesOnLi,
              location: capture.headquarter,
              fieldSources: {},
            })
            .returning();
          stored = row!;
          created = true;
        } else {
          const fill: Partial<typeof companies.$inferInsert> = {};
          const empty = (field: "domain" | "industry" | "employeeCount" | "location") =>
            (stored![field] === null || stored![field] === "") && !isManual(stored!.fieldSources, field);
          if (domain && empty("domain")) fill.domain = domain;
          if (capture.industry && empty("industry")) fill.industry = capture.industry;
          if (capture.employeesOnLi !== undefined && empty("employeeCount")) fill.employeeCount = capture.employeesOnLi;
          if (capture.headquarter && empty("location")) fill.location = capture.headquarter;
          if (Object.keys(fill).length) {
            await tx
              .update(companies)
              .set({ ...fill, updatedAt: new Date() })
              .where(and(eq(companies.workspaceId, actor.workspaceId), eq(companies.id, stored.id)));
          }
        }
        await pointIdentities(tx, actor.workspaceId, "company", keys, stored.id);

        const [previous] = await tx
          .select({ rawData: enrichmentSnapshots.rawData })
          .from(enrichmentSnapshots)
          .where(
            and(
              eq(enrichmentSnapshots.workspaceId, actor.workspaceId),
              eq(enrichmentSnapshots.entityType, "company"),
              eq(enrichmentSnapshots.entityId, stored.id)
            )
          )
          .orderBy(desc(enrichmentSnapshots.capturedAt))
          .limit(1);
        const merged = mergeCompanyCapture((previous?.rawData ?? {}) as Json, {
          ...capture,
          domain,
          captureSource: "linkedin-company-page",
          capturedAt: capture.capturedAt ?? new Date().toISOString(),
        });
        await writeSnapshot(tx, actor, "company", stored.id, merged);
        await recordObservedFacts(tx, {
          workspaceId: actor.workspaceId,
          entityType: "company",
          entityId: stored.id,
          origin: "companyPage",
          sourceUrl: capture.sourceUrl,
          observedAt,
          retentionDays,
          facts: {
            name: capture.name,
            website: capture.website,
            domain,
            industry: capture.industry,
            headquarter: capture.headquarter,
            size: capture.size,
            employeesOnLi: capture.employeesOnLi,
            followers: capture.followers,
            tagline: capture.tagline,
            overview: capture.overview,
            foundedAt: capture.foundedAt,
            specialties: capture.specialties,
            phone: capture.phone,
            peopleStats: capture.peopleStats,
            linkedinUrl: `https://www.linkedin.com/company/${capture.publicId}/`,
          },
        });
        // A new company that shares its name with saved ones is not merged on the name alone:
        // it is queued as a merge proposal for a person to review.
        if (created && capture.name) {
          const sameName = (await companiesNamed(tx, actor.workspaceId, capture.name)).filter((row) => row.id !== stored!.id);
          for (const other of sameName.slice(0, 3)) {
            const [pending] = await tx
              .select({ id: identityMergeProposals.id })
              .from(identityMergeProposals)
              .where(
                and(
                  eq(identityMergeProposals.workspaceId, actor.workspaceId),
                  eq(identityMergeProposals.entityType, "company"),
                  eq(identityMergeProposals.leftEntityId, other.id),
                  eq(identityMergeProposals.rightEntityId, stored.id)
                )
              )
              .limit(1);
            if (pending) continue;
            await proposeMerge(tx as unknown as Db, {
              workspaceId: actor.workspaceId,
              entityType: "company",
              leftEntityId: other.id,
              rightEntityId: stored.id,
              left: { name: other.name, domain: other.domain ?? undefined, location: other.location ?? undefined },
              right: { name: stored.name, domain: stored.domain ?? undefined, location: stored.location ?? undefined },
            });
          }
        }
        return { id: stored.id, name: stored.name, domain: stored.domain, created };
      });
      companyResult = { id: company.id, created: company.created };

      const counts = { received: people.length, created: 0, merged: 0, rejected: 0 };
      // Company people results can include affiliates, former employees and similarly named
      // companies: saved as discovery candidates; only a profile capture verifies the employer.
      for (const profile of people) {
        if (!isUsableCardName(profile.fullName)) {
          counts.rejected++;
          continue;
        }
        const saved = await db.transaction((tx) =>
          upsertPersonRecord(tx, actor, {
            evidence: { origin: "companyPeopleCard", sourceUrl: capture.sourceUrl, observedAt, retentionDays },
            mode: "card",
            publicId: publicIdFromProfileUrl(profile.sourceUrl),
            fullName: profile.fullName,
            headline: profile.headline,
            companyName: company.name,
            companyDomain: company.domain ?? undefined,
            companyId: company.id,
            discoverySource: profile.associationSource ?? "company-search-result",
            facts: {
              sourceUrl: profile.sourceUrl,
              captureSource: profile.associationSource ?? "company-search-result",
              capturedAt: capture.capturedAt ?? new Date().toISOString(),
            },
          })
        );
        if (saved.created) counts.created++;
        else counts.merged++;
      }
      return counts;
    }
  );
  return { ...outcome, company: companyResult };
}

/** Public ids already associated with a saved company, so the extension can skip them. */
export async function capturedCompanyProfileIds(db: Db, workspaceId: string, companyPublicId: string): Promise<string[]> {
  const [identity] = await db
    .select({ entityId: enrichmentIdentities.entityId })
    .from(enrichmentIdentities)
    .where(
      and(
        eq(enrichmentIdentities.workspaceId, workspaceId),
        eq(enrichmentIdentities.entityType, "company"),
        eq(enrichmentIdentities.canonicalKey, companyPublicKey(companyPublicId))
      )
    )
    .limit(1);
  if (!identity) return [];
  const rows = await db
    .select({ key: enrichmentIdentities.canonicalKey })
    .from(companyPersonDiscoveries)
    .innerJoin(
      enrichmentIdentities,
      and(
        eq(enrichmentIdentities.workspaceId, companyPersonDiscoveries.workspaceId),
        eq(enrichmentIdentities.entityType, "person"),
        eq(enrichmentIdentities.entityId, companyPersonDiscoveries.contactId)
      )
    )
    .where(and(eq(companyPersonDiscoveries.workspaceId, workspaceId), eq(companyPersonDiscoveries.companyId, identity.entityId)));
  return [...new Set(rows.map((row) => row.key).filter((key) => key.startsWith("in:")).map((key) => key.slice(3)))];
}

// ── Manual identity actions (ENR-03) ──────────────────────────────────────────

export interface AttachPublicUrlResult {
  prospectId: string;
  contactId: string;
  linkedinUrl: string;
  /** True when the lead was folded into a record that already had this public profile. */
  merged: boolean;
}

/**
 * Attaches a real public profile URL to a Sales Navigator lead. The URL is supplied by a
 * person who has seen it; it is never derived from the lead id. If the workspace already has
 * a record for that profile, the lead is merged into it. Employment stays a discovery
 * candidate: only a capture of the profile itself verifies an employer.
 */
export async function attachPublicProfileUrl(
  db: Db,
  actor: CaptureActor,
  prospectId: string,
  url: string
): Promise<AttachPublicUrlResult> {
  const publicId = publicIdFromProfileUrl(url);
  if (!publicId) throw new CaptureError("invalid_public_url", 400, "Enter a public LinkedIn profile URL (https://www.linkedin.com/in/…).");
  const linkedinUrl = canonicalPublicProfileUrl(publicId);
  const retentionDays = await readRetentionDays(db, actor.workspaceId);

  return db.transaction(async (tx) => {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspaceId, actor.workspaceId), eq(contacts.sourceProspectId, prospectId), isNull(contacts.deletedAt)))
      .limit(1);
    if (!contact) throw new CaptureError("person_not_found", 404, "Person not found.");

    const existingPublicId = publicIdFromProfileUrl(contact.linkedinUrl ?? "");
    if (existingPublicId && existingPublicId !== publicId) {
      throw new CaptureError("public_url_conflict", 409, "This person already has a different public LinkedIn URL.");
    }

    const key = personPublicKey(publicId);
    await lockKeys(tx, actor.workspaceId, "person", [key]);
    const targets = await identityTargets(tx, actor.workspaceId, "person", [key]);
    const [byIdentity] = await liveContacts(tx, actor.workspaceId, targets.has(key) ? [targets.get(key)!] : []);
    const other = byIdentity ?? (await contactByPublicUrl(tx, actor.workspaceId, publicId));

    let survivor = contact;
    let merged = false;
    if (other && other.id !== contact.id) {
      if (!other.sourceProspectId) {
        // Give the existing CRM contact a prospect record so the lead's history has a home.
        other.sourceProspectId = prospectIdForCanonicalKey(key);
        await tx
          .update(contacts)
          .set({ sourceProspectId: other.sourceProspectId, updatedAt: new Date() })
          .where(and(eq(contacts.workspaceId, actor.workspaceId), eq(contacts.id, other.id)));
        const [leadActivation] = await tx
          .select()
          .from(prospectActivations)
          .where(and(eq(prospectActivations.workspaceId, actor.workspaceId), eq(prospectActivations.prospectId, prospectId)))
          .limit(1);
        await tx
          .insert(prospectActivations)
          .values({
            workspaceId: actor.workspaceId,
            prospectId: other.sourceProspectId,
            companyId: leadActivation?.companyId ?? null,
            snapshot: { prospectId: other.sourceProspectId, linkedinUrl, linkedinPublicId: publicId },
          })
          .onConflictDoNothing();
      }
      await mergeLeadIntoPublic(tx, actor, contact, other, "public_url_attached");
      survivor = other;
      merged = true;
    }
    if (!publicIdFromProfileUrl(survivor.linkedinUrl ?? "")) {
      await tx
        .update(contacts)
        .set({ linkedinUrl, updatedAt: new Date() })
        .where(and(eq(contacts.workspaceId, actor.workspaceId), eq(contacts.id, survivor.id)));
    }
    await pointIdentities(tx, actor.workspaceId, "person", [key], survivor.id);

    const survivorProspectId = survivor.sourceProspectId!;
    await tx
      .update(prospectActivations)
      .set({
        snapshot: sql`coalesce(${prospectActivations.snapshot}, '{}'::jsonb) || ${JSON.stringify({ linkedinUrl, linkedinPublicId: publicId })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(prospectActivations.workspaceId, actor.workspaceId), eq(prospectActivations.prospectId, survivorProspectId)));

    await recordObservedFacts(tx, {
      workspaceId: actor.workspaceId,
      entityType: "prospect",
      entityId: survivorProspectId,
      origin: "manual",
      sourceUrl: linkedinUrl,
      observedAt: new Date(),
      retentionDays,
      reviewerId: actor.userId,
      facts: { linkedinUrl },
    });
    await recordPrivilegedAction(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "enrichment.attach_public_url",
      entityType: "person",
      entityId: survivor.id,
      beforeState: { prospectId, contactId: contact.id, linkedinUrl: contact.linkedinUrl },
      afterState: { prospectId: survivorProspectId, contactId: survivor.id, linkedinUrl, merged },
    });
    return { prospectId: survivorProspectId, contactId: survivor.id, linkedinUrl, merged };
  });
}

export type AddLinkedinUrlResult =
  | { kind: "person"; prospectId: string; contactId: string; created: boolean; linkedinUrl: string }
  | { kind: "company"; companyId: string; created: boolean; linkedinUrl: string };

/**
 * Registers a LinkedIn profile or company URL so it can be captured. Only the URL is
 * recorded: nothing is fetched from LinkedIn and no name or other fact is filled in.
 */
export async function addLinkedinUrl(db: Db, actor: CaptureActor, url: string): Promise<AddLinkedinUrlResult> {
  const publicId = publicIdFromProfileUrl(url);
  const companyId = publicId ? undefined : companyIdFromCompanyUrl(url);
  if (!publicId && !companyId) {
    throw new CaptureError("invalid_linkedin_url", 400, "Enter a LinkedIn profile (/in/…) or company (/company/…) URL.");
  }
  const retentionDays = await readRetentionDays(db, actor.workspaceId);
  const observedAt = new Date();

  return db.transaction(async (tx): Promise<AddLinkedinUrlResult> => {
    if (publicId) {
      const linkedinUrl = canonicalPublicProfileUrl(publicId);
      const saved = await upsertPersonRecord(tx, actor, {
        mode: "card",
        publicId,
        discoverySource: "manual_linkedin_url",
        facts: { captureSource: "manual_linkedin_url" },
        evidence: { origin: "manual", sourceUrl: linkedinUrl, observedAt, retentionDays, reviewerId: actor.userId },
      });
      await recordPrivilegedAction(tx, {
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        action: "enrichment.add_linkedin_url",
        entityType: "person",
        entityId: saved.contactId,
        afterState: { prospectId: saved.prospectId, linkedinUrl, created: saved.created },
      });
      return { kind: "person", prospectId: saved.prospectId, contactId: saved.contactId, created: saved.created, linkedinUrl };
    }

    const key = companyPublicKey(companyId!);
    const linkedinUrl = `https://www.linkedin.com/company/${companyId}/`;
    await lockKeys(tx, actor.workspaceId, "company", [key]);
    let company = await companyByKeys(tx, actor.workspaceId, [key]);
    const created = !company;
    if (!company) {
      // The slug stands in for the name until the company page is captured.
      [company] = await tx.insert(companies).values({ workspaceId: actor.workspaceId, name: companyId!, fieldSources: {} }).returning();
      await pointIdentities(tx, actor.workspaceId, "company", [key], company!.id);
    }
    await recordObservedFacts(tx, {
      workspaceId: actor.workspaceId,
      entityType: "company",
      entityId: company!.id,
      origin: "manual",
      sourceUrl: linkedinUrl,
      observedAt,
      retentionDays,
      reviewerId: actor.userId,
      facts: { linkedinUrl },
    });
    await recordPrivilegedAction(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "enrichment.add_linkedin_url",
      entityType: "company",
      entityId: company!.id,
      afterState: { linkedinUrl, created },
    });
    return { kind: "company", companyId: company!.id, created, linkedinUrl };
  });
}
