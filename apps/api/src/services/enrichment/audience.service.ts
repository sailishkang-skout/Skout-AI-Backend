/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md.
 *   - Tables touched directly: contacts, companies (owned by apps/crm) — read only
 *   - Reason: audience segmentation filters people on their CRM employer, location and email
 *     in one query, the same join the ENR-03 research read model uses.
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { and, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { recordPrivilegedAction } from "@skout/auth";
import { z } from "zod";
import { EVIDENCE_POLICY } from "./capture-evidence.js";
import { CaptureError, type CaptureActor } from "./capture-ingest.service.js";
import { peopleFrom, personColumns, personFilters, toPersonSummary, type PersonSummary } from "./research.service.js";

/**
 * ENR-05 — audience segmentation over captured people.
 *
 * An audience is a set of filters: role, department, seniority, location, company context,
 * evidence state (verified employment vs. a discovery card) and freshness. Saving one writes its
 * current members to an ordinary static list, so it can be used anywhere a list can. An audience
 * says who matches; it does not say who may be contacted — that is decided per recipient when a
 * campaign is built, and again when it is launched.
 */

const { companies, contacts, emailVerifications, enrichmentAudiences, listMembers, lists, prospectActivations, suppressions } = schema;

/** A campaign is reviewed person by person; an audience larger than this is not reviewable. */
export const MAX_AUDIENCE_SIZE = 500;

const term = z.string().trim().min(1).max(120).optional();
export const audienceFiltersSchema = z
  .object({
    q: term,
    /** Words in the person's title or headline. */
    role: term,
    department: term,
    seniority: term,
    location: term,
    companyId: z.string().uuid().optional(),
    industry: term,
    minEmployees: z.number().int().min(0).max(10_000_000).optional(),
    maxEmployees: z.number().int().min(0).max(10_000_000).optional(),
    /** verified = employer confirmed on the person's own profile; discovery = seen on a search card. */
    evidenceState: z.enum(["verified", "discovery"]).optional(),
    /** fresh = captured within the evidence freshness window. */
    freshness: z.enum(["fresh", "stale"]).optional(),
  })
  .strict();
export type AudienceFilters = z.infer<typeof audienceFiltersSchema>;

const like = (value: string) => `%${value.trim().replace(/[\\%_]/g, "\\$&")}%`;
const snap = (key: string) => sql`${prospectActivations.snapshot}->>${key}`;
const CAPTURED_AT = sql`(case when ${snap("capturedAt")} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (${snap("capturedAt")})::timestamptz else ${prospectActivations.updatedAt} end)`;
const FRESH_SQL = sql`(${CAPTURED_AT} >= now() - make_interval(days => ${EVIDENCE_POLICY.FRESHNESS_DAYS}))`;
const VERIFIED_SQL = sql`(${contacts.employmentStatus} = 'verified_employment' and ${contacts.companyId} is not null)`;
const HAS_EMAIL_SQL = sql`(${contacts.email} is not null and ${contacts.email} <> '')`;
const VERIFIED_EMAIL_SQL = sql`exists (select 1 from ${emailVerifications} ev where ev.workspace_id = ${prospectActivations.workspaceId} and ev.prospect_id = ${prospectActivations.prospectId} and ev.status = 'valid' and lower(ev.email) = lower(${contacts.email}))`;
/** A person added by URL and not yet captured has no facts to segment on or to write about. */
const CAPTURED_SQL = sql`(nullif(btrim(${snap("fullName")}), '') is not null)`;
const SUPPRESSED_SQL = sql`exists (select 1 from ${suppressions} sp where sp.workspace_id = ${prospectActivations.workspaceId} and sp.email = lower(${contacts.email}))`;

function audienceWhere(workspaceId: string, filters: AudienceFilters): SQL {
  const where: SQL[] = [
    eq(prospectActivations.workspaceId, workspaceId),
    CAPTURED_SQL,
    ...personFilters({
      q: filters.q,
      department: filters.department,
      seniority: filters.seniority,
      companyId: filters.companyId,
      state: filters.evidenceState === "verified" ? "verified" : filters.evidenceState === "discovery" ? "candidate" : undefined,
    }),
  ];
  if (filters.role) {
    const pattern = like(filters.role);
    where.push(sql`(${snap("title")} ilike ${pattern} or ${snap("headline")} ilike ${pattern} or ${contacts.title} ilike ${pattern})`);
  }
  if (filters.location) {
    const pattern = like(filters.location);
    where.push(sql`(${snap("location")} ilike ${pattern} or ${snap("locationName")} ilike ${pattern})`);
  }
  if (filters.industry) where.push(sql`${companies.industry} ilike ${like(filters.industry)}`);
  if (filters.minEmployees !== undefined) where.push(sql`${companies.employeeCount} >= ${filters.minEmployees}`);
  if (filters.maxEmployees !== undefined) where.push(sql`${companies.employeeCount} <= ${filters.maxEmployees}`);
  if (filters.freshness === "fresh") where.push(FRESH_SQL);
  if (filters.freshness === "stale") where.push(sql`not ${FRESH_SQL}`);
  return and(...where)!;
}

export interface AudienceCounts {
  total: number;
  /** Employer confirmed on the person's own profile. */
  verifiedEmployment: number;
  /** Seen on a search card only. */
  discoveryOnly: number;
  fresh: number;
  stale: number;
  withEmail: number;
  /** An email the verification service confirmed as valid — the only kind that can be enrolled. */
  verifiedEmail: number;
  suppressed: number;
  freshnessDays: number;
}

const n = (value: unknown) => Number(value ?? 0);

export async function countAudience(db: Db, workspaceId: string, filters: AudienceFilters): Promise<AudienceCounts> {
  const [row] = await peopleFrom(
    db.select({
      total: sql<number>`count(*)::int`,
      verified: sql<number>`count(*) filter (where ${VERIFIED_SQL})::int`,
      fresh: sql<number>`count(*) filter (where ${FRESH_SQL})::int`,
      withEmail: sql<number>`count(*) filter (where ${HAS_EMAIL_SQL})::int`,
      verifiedEmail: sql<number>`count(*) filter (where ${HAS_EMAIL_SQL} and ${VERIFIED_EMAIL_SQL})::int`,
      suppressed: sql<number>`count(*) filter (where ${HAS_EMAIL_SQL} and ${SUPPRESSED_SQL})::int`,
    })
  ).where(audienceWhere(workspaceId, filters));
  const counts = (row ?? {}) as Record<string, unknown>;
  const total = n(counts.total);
  return {
    total,
    verifiedEmployment: n(counts.verified),
    discoveryOnly: total - n(counts.verified),
    fresh: n(counts.fresh),
    stale: total - n(counts.fresh),
    withEmail: n(counts.withEmail),
    verifiedEmail: n(counts.verifiedEmail),
    suppressed: n(counts.suppressed),
    freshnessDays: EVIDENCE_POLICY.FRESHNESS_DAYS,
  };
}

export async function audienceMembers(db: Db, workspaceId: string, filters: AudienceFilters, limit = MAX_AUDIENCE_SIZE): Promise<PersonSummary[]> {
  const rows = await peopleFrom(db.select(personColumns))
    .where(audienceWhere(workspaceId, filters))
    .orderBy(desc(prospectActivations.updatedAt), prospectActivations.prospectId)
    .limit(limit);
  return (rows as Parameters<typeof toPersonSummary>[0][]).map(toPersonSummary);
}

/** Live counts and a first page of matches, for the audience builder. */
export async function previewAudience(db: Db, workspaceId: string, filters: AudienceFilters) {
  const [counts, sample] = await Promise.all([countAudience(db, workspaceId, filters), audienceMembers(db, workspaceId, filters, 25)]);
  return { counts, sample, maxAudienceSize: MAX_AUDIENCE_SIZE, tooLarge: counts.total > MAX_AUDIENCE_SIZE };
}

type AudienceRow = typeof enrichmentAudiences.$inferSelect;

function toAudienceDto(row: AudienceRow) {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters as AudienceFilters,
    listId: row.listId,
    stats: row.stats as { counts?: AudienceCounts; outcomes?: Record<string, number> },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type AudienceDto = ReturnType<typeof toAudienceDto>;

export async function listAudiences(db: Db, workspaceId: string): Promise<AudienceDto[]> {
  const rows = await db
    .select()
    .from(enrichmentAudiences)
    .where(eq(enrichmentAudiences.workspaceId, workspaceId))
    .orderBy(desc(enrichmentAudiences.updatedAt))
    .limit(200);
  return rows.map(toAudienceDto);
}

export async function getAudienceRow(db: Db, workspaceId: string, id: string): Promise<AudienceRow | null> {
  const [row] = await db
    .select()
    .from(enrichmentAudiences)
    .where(and(eq(enrichmentAudiences.workspaceId, workspaceId), eq(enrichmentAudiences.id, id)))
    .limit(1);
  return row ?? null;
}

export async function getAudience(db: Db, workspaceId: string, id: string) {
  const row = await getAudienceRow(db, workspaceId, id);
  if (!row) return null;
  return { audience: toAudienceDto(row), ...(await previewAudience(db, workspaceId, row.filters as AudienceFilters)) };
}

/**
 * Saves an audience and writes its current members to a static list (created on first save,
 * brought up to date on later ones). Saving again is how an audience is refreshed.
 */
export async function saveAudience(
  db: Db,
  actor: CaptureActor,
  input: { id?: string; name: string; filters: AudienceFilters }
): Promise<AudienceDto> {
  const { workspaceId } = actor;
  const counts = await countAudience(db, workspaceId, input.filters);
  if (counts.total === 0) throw new CaptureError("audience_empty", 422, "Nobody matches these filters. Loosen them before saving.");
  if (counts.total > MAX_AUDIENCE_SIZE) {
    throw new CaptureError("audience_too_large", 422, `${counts.total} people match. Narrow the audience to ${MAX_AUDIENCE_SIZE} or fewer so every recipient can be reviewed.`);
  }
  const members = await audienceMembers(db, workspaceId, input.filters);
  const prospectIds = members.map((member) => member.prospectId);
  const now = new Date();

  return db.transaction(async (tx) => {
    const existing = input.id ? await getAudienceRow(tx as unknown as Db, workspaceId, input.id) : null;
    if (input.id && !existing) throw new CaptureError("audience_not_found", 404, "This audience does not exist in your workspace.");

    let listId = existing?.listId ?? null;
    if (!listId) {
      const [list] = await tx.insert(lists).values({ workspaceId, name: `Audience: ${input.name}` }).returning({ id: lists.id });
      listId = list!.id;
    } else {
      await tx.update(lists).set({ name: `Audience: ${input.name}`, updatedAt: now }).where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)));
      await tx.delete(listMembers).where(and(eq(listMembers.listId, listId), notInArray(listMembers.prospectId, prospectIds)));
    }
    await tx.insert(listMembers).values(prospectIds.map((prospectId) => ({ listId: listId!, prospectId }))).onConflictDoNothing();

    const stats = { ...((existing?.stats as object | undefined) ?? {}), counts };
    const [row] = existing
      ? await tx
          .update(enrichmentAudiences)
          .set({ name: input.name, filters: input.filters, listId, stats, updatedAt: now })
          .where(eq(enrichmentAudiences.id, existing.id))
          .returning()
      : await tx
          .insert(enrichmentAudiences)
          .values({ workspaceId, name: input.name, filters: input.filters, listId, stats, createdBy: actor.userId })
          .returning();
    await recordPrivilegedAction(tx, {
      workspaceId,
      actorId: actor.userId,
      action: existing ? "enrichment.audience.update" : "enrichment.audience.create",
      entityType: "enrichment_audience",
      entityId: row!.id,
      afterState: { name: input.name, filters: input.filters, listId, members: prospectIds.length },
    });
    return toAudienceDto(row!);
  });
}

/** Deletes the audience definition. Its list, and campaigns already built from it, are kept. */
export async function deleteAudience(db: Db, actor: CaptureActor, id: string): Promise<boolean> {
  const removed = await db
    .delete(enrichmentAudiences)
    .where(and(eq(enrichmentAudiences.workspaceId, actor.workspaceId), eq(enrichmentAudiences.id, id)))
    .returning({ id: enrichmentAudiences.id, name: enrichmentAudiences.name });
  if (!removed.length) return false;
  await recordPrivilegedAction(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: "enrichment.audience.delete",
    entityType: "enrichment_audience",
    entityId: id,
    beforeState: { name: removed[0]!.name },
  });
  return true;
}

/** Adds campaign outcomes to the audience they came from: its record of how well it performed. */
export async function addAudienceOutcome(db: Db, workspaceId: string, audienceId: string, outcome: "sent" | "replied" | "bounced" | "unsubscribed"): Promise<void> {
  await db
    .update(enrichmentAudiences)
    .set({
      stats: sql`jsonb_set(${enrichmentAudiences.stats}, '{outcomes}', coalesce(${enrichmentAudiences.stats}->'outcomes', '{}'::jsonb) || jsonb_build_object(${outcome}::text, coalesce((${enrichmentAudiences.stats}->'outcomes'->>${outcome})::int, 0) + 1), true)`,
    })
    .where(and(eq(enrichmentAudiences.workspaceId, workspaceId), eq(enrichmentAudiences.id, audienceId)));
}

export async function prospectsExist(db: Db, workspaceId: string, prospectIds: string[]): Promise<string[]> {
  if (!prospectIds.length) return [];
  const rows = await db
    .select({ prospectId: prospectActivations.prospectId })
    .from(prospectActivations)
    .where(and(eq(prospectActivations.workspaceId, workspaceId), inArray(prospectActivations.prospectId, prospectIds)));
  return rows.map((row) => row.prospectId);
}
