/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-02 Latest Job Roles.
 *   - Tables touched directly: companies (owned by apps/crm)
 *     - read only (the company's name, for a requested job rescan)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a job scan is attached to the company the capture created through
 *     ingestCompanyCapture; the name is joined with the capture identity key (the LinkedIn company
 *     id) in one query, as in capture-queue.service.ts and research.service.ts.
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { normalizeLinkedinId } from "./capture-identity.js";
import type { JobRoleInput, JobScanInput } from "./capture-schemas.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RoleRow = typeof schema.companyJobRoles.$inferSelect;
type ScanRow = typeof schema.companyJobScans.$inferSelect;

/** A verified scan that does not see a role this many times in a row marks it "not seen". Never "closed". */
export const MISSED_SCANS_BEFORE_NOT_SEEN = 2;
/** A scan that says it is running but has not finished for this long is shown as interrupted. */
export const JOB_SCAN_STALE_MS = 30 * 60 * 1000;
/** A role detected or changed in this window is flagged New / Updated. */
export const JOB_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export const JOB_SCAN_STATUSES = [
  "requested",
  "in_progress",
  "completed_verified",
  "verification_required",
  "partial",
  "not_found",
  "restricted",
  "not_loaded",
  "failed",
] as const;
export type JobScanStatus = (typeof JOB_SCAN_STATUSES)[number];

const lower = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "");

/** What identifies a role when LinkedIn gave no job id: its title and location. */
export function jobSignature(job: Pick<JobRoleInput, "title" | "location">): string {
  return createHash("sha1").update(`${lower(job.title)}|${lower(job.location)}`).digest("hex").slice(0, 24);
}

/** The stable key of a role: the LinkedIn job id when known, else the title and location. */
export function jobKey(job: Pick<JobRoleInput, "jobId" | "title" | "location">): string {
  return job.jobId ? `id:${job.jobId}` : `text:${jobSignature(job)}`;
}

const TRACKED_FIELDS = ["title", "department", "location", "country", "employmentType", "workplaceType", "postedAt", "jobUrl", "description", "requirements"] as const;

function clean<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}

/**
 * What the scan can be trusted for. A scan that failed, was restricted, or could not load is never
 * an empty result; one that found jobs but could not confirm the list is complete needs verifying;
 * "not found" requires two complete passes that agree.
 */
export function scanOutcome(scan: Pick<JobScanInput, "status" | "passes" | "error">, jobCount: number): { status: JobScanStatus; verified: boolean } {
  const passes = scan.passes ?? [];
  const everyComplete = passes.length > 0 && passes.every((pass) => pass.complete);
  const verified = passes.length >= 2 && everyComplete;
  if (scan.status === "in_progress") return { status: "in_progress", verified: false };
  if (scan.status === "failed" || scan.status === "restricted" || scan.status === "not_loaded") {
    // Whatever was read before it stopped is kept; the scan itself is not a success.
    return { status: jobCount > 0 ? "partial" : scan.status, verified: false };
  }
  if (jobCount > 0) {
    if (verified) return { status: "completed_verified", verified: true };
    return { status: passes.length >= 2 || passes.some((pass) => !pass.complete) ? "partial" : "verification_required", verified: false };
  }
  // Zero jobs: only two complete passes (and the second used another method) confirm there are none.
  if (verified && !scan.error) return { status: "not_found", verified: true };
  return { status: "verification_required", verified: false };
}

function workplace(value: unknown): "remote" | "hybrid" | "on_site" | undefined {
  const normalized = lower(value).replace(/[-_\s]+/g, "");
  if (normalized === "remote") return "remote";
  if (normalized === "hybrid") return "hybrid";
  if (normalized === "onsite") return "on_site";
  return undefined;
}

/** Writes a scan's jobs. Counts new and updated roles; never duplicates, never overwrites with less. */
async function upsertRoles(tx: Tx, workspaceId: string, companyId: string, jobs: JobRoleInput[], verified: boolean, now: Date) {
  const table = schema.companyJobRoles;
  const existing = await tx.select().from(table).where(and(eq(table.workspaceId, workspaceId), eq(table.companyId, companyId)));
  const byKey = new Map(existing.map((row) => [row.jobKey, row]));
  const textRowsBySignature = new Map<string, RoleRow[]>();
  for (const row of existing) {
    if (!row.jobKey.startsWith("text:")) continue;
    const list = textRowsBySignature.get(row.jobKey.slice(5)) ?? [];
    list.push(row);
    textRowsBySignature.set(row.jobKey.slice(5), list);
  }
  const idRowsBySignature = new Map<string, RoleRow[]>();
  for (const row of existing) {
    if (!row.jobKey.startsWith("id:")) continue;
    const signature = jobSignature({ title: row.title, location: row.location ?? undefined });
    idRowsBySignature.set(signature, [...(idRowsBySignature.get(signature) ?? []), row]);
  }

  // One entry per role within the scan: a role read with its id wins over the same role without.
  const incoming = new Map<string, JobRoleInput>();
  for (const job of jobs) {
    const key = jobKey(job);
    incoming.set(key, { ...incoming.get(key), ...clean(job), title: job.title } as JobRoleInput);
  }
  for (const [key, job] of [...incoming]) {
    if (job.jobId) continue;
    const identified = [...incoming.entries()].filter(([other, value]) => value.jobId && jobSignature(value) === jobSignature(job));
    if (identified.length === 1) {
      incoming.set(identified[0]![0], { ...job, ...incoming.get(identified[0]![0])! });
      incoming.delete(key);
    }
  }

  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  for (const [key, job] of incoming) {
    const signature = jobSignature(job);
    let row = byKey.get(key);
    // The same role first read without an id, then with one (or the reverse): one row, not two.
    if (!row && job.jobId) {
      const candidates = textRowsBySignature.get(signature) ?? [];
      if (candidates.length === 1) row = candidates[0];
    }
    if (!row && !job.jobId) {
      const candidates = idRowsBySignature.get(signature) ?? [];
      if (candidates.length === 1) row = candidates[0];
    }
    const next = {
      title: job.title,
      companyName: job.companyName,
      department: job.department,
      location: job.location,
      country: job.country,
      employmentType: job.employmentType,
      workplaceType: workplace(job.workplaceType),
      description: job.description,
      requirements: job.requirements,
      postedAt: job.postedAt ? new Date(job.postedAt) : undefined,
      postedText: job.postedText,
      jobUrl: job.jobUrl,
      externalJobId: job.jobId,
      source: job.source ?? "linkedin_extension",
    };
    if (!row) {
      const [inserted] = await tx
        .insert(table)
        .values({
          workspaceId,
          companyId,
          jobKey: key,
          ...clean(next),
          title: job.title,
          source: next.source,
          detailsComplete: Boolean(job.description),
          status: "open",
          missedScans: 0,
          firstDetectedAt: now,
          lastSeenAt: now,
          lastVerifiedAt: verified ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        created++;
        seen.add(inserted.jobKey);
        byKey.set(inserted.jobKey, inserted);
        continue;
      }
      // Lost a race with a concurrent scan of the same company: it exists now, so update it.
      const [found] = await tx.select().from(table).where(and(eq(table.workspaceId, workspaceId), eq(table.companyId, companyId), eq(table.jobKey, key))).limit(1);
      if (!found) continue;
      row = found;
    }

    const changes: Partial<typeof table.$inferInsert> = {};
    let changed = false;
    for (const field of TRACKED_FIELDS) {
      const value = (next as Record<string, unknown>)[field];
      if (value === undefined) continue;
      // The longer description wins: a card's snippet never replaces the full text.
      if (field === "description" && typeof row.description === "string" && row.description.length >= String(value).length) continue;
      const before = (row as Record<string, unknown>)[field];
      const same = value instanceof Date ? before instanceof Date && before.getTime() === value.getTime() : before === value;
      if (!same) {
        (changes as Record<string, unknown>)[field] = value;
        changed = true;
      }
    }
    for (const field of ["companyName", "postedText"] as const) {
      const value = next[field];
      if (value !== undefined && row[field] !== value) (changes as Record<string, unknown>)[field] = value;
    }
    // A role first read without an id and now with one takes the id as its key.
    if (job.jobId && row.jobKey !== `id:${job.jobId}`) {
      changes.jobKey = `id:${job.jobId}`;
      changes.externalJobId = job.jobId;
    }
    if (job.description) changes.detailsComplete = true;
    if (changed) updated++;
    seen.add(row.jobKey);
    await tx
      .update(table)
      .set({
        ...changes,
        status: "open",
        missedScans: 0,
        lastSeenAt: now,
        ...(verified ? { lastVerifiedAt: now } : {}),
        ...(changed ? { changedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(table.id, row.id));
    seen.add(changes.jobKey ?? row.jobKey);
  }
  return { created, updated, seen };
}

/** A verified scan that did not see a role counts a miss; after two it is "not seen". Never closed. */
async function recordMisses(tx: Tx, workspaceId: string, companyId: string, seen: Set<string>) {
  const table = schema.companyJobRoles;
  const rows = await tx.select().from(table).where(and(eq(table.workspaceId, workspaceId), eq(table.companyId, companyId)));
  const missed = rows.filter((row) => !seen.has(row.jobKey));
  if (!missed.length) return 0;
  await tx
    .update(table)
    .set({
      missedScans: sql`${table.missedScans} + 1`,
      status: sql`CASE WHEN ${table.missedScans} + 1 >= ${MISSED_SCANS_BEFORE_NOT_SEEN} THEN 'not_seen' ELSE ${table.status} END`,
      updatedAt: new Date(),
    })
    .where(inArray(table.id, missed.map((row) => row.id)));
  return missed.length;
}

export function scanDto(row: ScanRow, now = Date.now()) {
  const stale = row.status === "in_progress" && now - (row.startedAt ?? row.createdAt).getTime() > JOB_SCAN_STALE_MS;
  return {
    id: row.id,
    status: row.status as JobScanStatus,
    // An "in progress" scan that stopped reporting: it did not finish, and is not a result.
    state: stale ? ("interrupted" as const) : (row.status as JobScanStatus),
    source: row.source,
    passes: row.passes,
    jobsFound: row.jobsFound,
    jobsNew: row.jobsNew,
    jobsUpdated: row.jobsUpdated,
    verified: row.verified,
    details: row.details,
    error: row.error,
    requestedAt: row.requestedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The company id behind a LinkedIn company id (`company:<id>`), in this workspace. */
export async function companyIdForPublicId(db: Db | Tx, workspaceId: string, publicId: string): Promise<string | null> {
  const i = schema.enrichmentIdentities;
  const [row] = await db
    .select({ id: i.entityId })
    .from(i)
    .where(and(eq(i.workspaceId, workspaceId), eq(i.entityType, "company"), eq(i.canonicalKey, `company:${normalizeLinkedinId(publicId)}`)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Records one scan of a company's job listings (the extension's initial pass and its verification
 * pass) and the roles it found. Sending the same scan again records it once.
 */
export async function recordJobScan(
  db: Db | Tx,
  actor: { workspaceId: string; userId: string },
  companyId: string,
  scan: JobScanInput,
  now = new Date()
) {
  const run = async (tx: Tx) => {
    const scans = schema.companyJobScans;
    const [replay] = await tx
      .select()
      .from(scans)
      .where(and(eq(scans.workspaceId, actor.workspaceId), eq(scans.companyId, companyId), eq(scans.clientScanId, scan.clientScanId)))
      .limit(1);
    // The same finished scan again (its response was lost): nothing is written twice.
    if (replay && !["requested", "in_progress"].includes(replay.status)) return { scan: scanDto(replay), created: 0, updated: 0, replay: true };

    const outcome = scanOutcome(scan, scan.jobs.length);
    let created = 0;
    let updated = 0;
    if (scan.status !== "in_progress" && scan.jobs.length) {
      const result = await upsertRoles(tx, actor.workspaceId, companyId, scan.jobs, outcome.verified, now);
      created = result.created;
      updated = result.updated;
      // Absence only counts after a verified scan that read the whole list.
      if (outcome.status === "completed_verified") await recordMisses(tx, actor.workspaceId, companyId, result.seen);
    } else if (outcome.status === "not_found") {
      await recordMisses(tx, actor.workspaceId, companyId, new Set());
    }

    const values = {
      status: outcome.status,
      source: scan.source ?? null,
      passes: scan.passes.length,
      jobsFound: scan.jobs.length,
      jobsNew: created,
      jobsUpdated: updated,
      verified: outcome.verified,
      details: { passes: scan.passes, notes: scan.notes },
      error: scan.error ?? null,
      userId: actor.userId,
      startedAt: scan.startedAt ? new Date(scan.startedAt) : now,
      completedAt: outcome.status === "in_progress" ? null : scan.completedAt ? new Date(scan.completedAt) : now,
    };
    // A rescan asked for in the workspace is answered by the scan that follows it.
    const [open] = replay
      ? [replay]
      : await tx
          .select()
          .from(scans)
          .where(and(eq(scans.workspaceId, actor.workspaceId), eq(scans.companyId, companyId), inArray(scans.status, ["requested", "in_progress"]), isNull(scans.clientScanId)))
          .orderBy(scans.createdAt)
          .limit(1);
    const [saved] = open
      ? await tx.update(scans).set({ ...values, clientScanId: scan.clientScanId }).where(eq(scans.id, open.id)).returning()
      : await tx.insert(scans).values({ workspaceId: actor.workspaceId, companyId, clientScanId: scan.clientScanId, createdAt: now, ...values }).returning();
    return { scan: scanDto(saved!), created, updated, replay: false };
  };
  return "transaction" in db ? db.transaction(run) : run(db);
}

/** Asks for a company's jobs to be scanned again; the extension offers it. One open request at a time. */
export async function requestJobRescan(db: Db, actor: { workspaceId: string; userId: string }, companyId: string, now = new Date()) {
  const scans = schema.companyJobScans;
  const [open] = await db
    .select()
    .from(scans)
    .where(and(eq(scans.workspaceId, actor.workspaceId), eq(scans.companyId, companyId), inArray(scans.status, ["requested", "in_progress"])))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  if (open && !(open.status === "in_progress" && now.getTime() - (open.startedAt ?? open.createdAt).getTime() > JOB_SCAN_STALE_MS)) {
    return { scan: scanDto(open), alreadyRequested: true };
  }
  const [row] = await db
    .insert(scans)
    .values({ workspaceId: actor.workspaceId, companyId, status: "requested", requestedBy: actor.userId, requestedAt: now, createdAt: now })
    .returning();
  return { scan: scanDto(row!), alreadyRequested: false };
}

/** The extension reports that it has started a scan, so the workspace shows "in progress". */
export async function startJobScan(db: Db, actor: { workspaceId: string; userId: string }, companyId: string, clientScanId: string, now = new Date()) {
  return recordJobScan(db, actor, companyId, { clientScanId, status: "in_progress", passes: [], jobs: [], notes: [] }, now);
}

/** Companies the workspace asked to rescan, for the extension's side panel. */
export async function listRequestedJobScans(db: Db, workspaceId: string) {
  const scans = schema.companyJobScans;
  const companies = schema.companies;
  const identities = schema.enrichmentIdentities;
  const rows = await db
    .select({ id: scans.id, requestedAt: scans.requestedAt, name: companies.name, key: identities.canonicalKey })
    .from(scans)
    .innerJoin(companies, and(eq(companies.id, scans.companyId), eq(companies.workspaceId, scans.workspaceId)))
    .innerJoin(
      identities,
      and(eq(identities.workspaceId, scans.workspaceId), eq(identities.entityId, scans.companyId), eq(identities.entityType, "company"), sql`${identities.canonicalKey} like 'company:%'`)
    )
    .where(and(eq(scans.workspaceId, workspaceId), eq(scans.status, "requested")))
    .orderBy(scans.createdAt)
    .limit(100);
  const seen = new Set<string>();
  return rows
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .map((row) => ({ scanId: row.id, companyPublicId: row.key.slice("company:".length), name: row.name, requestedAt: row.requestedAt?.toISOString() ?? null }));
}

export const jobListSchema = z.object({
  includeNotSeen: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function roleDto(row: RoleRow, now = Date.now()) {
  const detected = row.firstDetectedAt.getTime();
  const changed = row.changedAt?.getTime() ?? 0;
  return {
    id: row.id,
    title: row.title,
    companyName: row.companyName,
    department: row.department,
    location: row.location,
    country: row.country,
    employmentType: row.employmentType,
    workplaceType: row.workplaceType,
    description: row.description,
    requirements: row.requirements,
    postedAt: row.postedAt?.toISOString() ?? null,
    postedText: row.postedText,
    jobUrl: row.jobUrl,
    jobId: row.externalJobId,
    source: row.source,
    /** open: in the latest verified scan | not_seen: missed by later verified scans. */
    status: row.status as "open" | "not_seen",
    detailsComplete: row.detailsComplete,
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    changedAt: row.changedAt?.toISOString() ?? null,
    isNew: now - detected < JOB_RECENT_MS,
    isUpdated: changed > detected && now - changed < JOB_RECENT_MS,
  };
}

/**
 * A company's job roles, newest first (posted date, else the day it was detected), with the scan
 * history that says how far the list can be trusted.
 */
export async function listCompanyJobs(db: Db, workspaceId: string, companyId: string, opts: { includeNotSeen?: boolean; limit?: number } = {}) {
  const roles = schema.companyJobRoles;
  const scans = schema.companyJobScans;
  const where = and(eq(roles.workspaceId, workspaceId), eq(roles.companyId, companyId), ...(opts.includeNotSeen ? [] : [eq(roles.status, "open")]));
  const [rows, [openCount], [notSeenCount], recentScans] = await Promise.all([
    db
      .select()
      .from(roles)
      .where(where)
      .orderBy(desc(sql`COALESCE(${roles.postedAt}, ${roles.firstDetectedAt})`), desc(roles.firstDetectedAt))
      .limit(opts.limit ?? 100),
    db.select({ total: sql<number>`count(*)::int` }).from(roles).where(and(eq(roles.workspaceId, workspaceId), eq(roles.companyId, companyId), eq(roles.status, "open"))),
    db.select({ total: sql<number>`count(*)::int` }).from(roles).where(and(eq(roles.workspaceId, workspaceId), eq(roles.companyId, companyId), eq(roles.status, "not_seen"))),
    db.select().from(scans).where(and(eq(scans.workspaceId, workspaceId), eq(scans.companyId, companyId))).orderBy(desc(scans.createdAt)).limit(10),
  ]);
  const now = Date.now();
  const finished = recentScans.find((scan) => !["requested", "in_progress"].includes(scan.status));
  const active = recentScans.find((scan) => ["requested", "in_progress"].includes(scan.status));
  return {
    jobs: rows.map((row) => roleDto(row, now)),
    total: Number(openCount?.total ?? 0),
    notSeen: Number(notSeenCount?.total ?? 0),
    lastScan: finished ? scanDto(finished, now) : null,
    activeScan: active ? scanDto(active, now) : null,
    scans: recentScans.map((scan) => scanDto(scan, now)),
  };
}

/** Counts for the Companies list: open roles per company. */
export async function jobRoleCounts(db: Db, workspaceId: string, companyIds: string[]) {
  if (!companyIds.length) return new Map<string, number>();
  const roles = schema.companyJobRoles;
  const rows = await db
    .select({ companyId: roles.companyId, total: sql<number>`count(*)::int` })
    .from(roles)
    .where(and(eq(roles.workspaceId, workspaceId), inArray(roles.companyId, companyIds), eq(roles.status, "open")))
    .groupBy(roles.companyId);
  return new Map(rows.map((row) => [row.companyId, Number(row.total)]));
}
