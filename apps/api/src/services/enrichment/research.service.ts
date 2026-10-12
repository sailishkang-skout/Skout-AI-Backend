/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-03 research read model and delete cascade.
 *   - Tables touched directly: contacts, companies (both owned by apps/crm)
 *     - read; write only on delete (soft-delete of capture-created contacts, company removal)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the research views join captured identity, activation snapshots, discovery
 *     edges and the Evidence Ledger with the CRM record in one query per page; same boundary
 *     as ENR-01/ENR-02 (prospect-crm-link.service.ts, capture-ingest.service.ts).
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { recordPrivilegedAction } from "@skout/auth";
import { prospectIdForCanonicalKey, publicIdFromProfileUrl } from "./capture-identity.js";
import { deleteCaptureEvidence } from "./capture-evidence.js";
import { CaptureError, type CaptureActor } from "./capture-ingest.service.js";

const {
  companies,
  contacts,
  prospectActivations,
  lists,
  listMembers,
  asyncJobs,
  enrichmentJobs,
  skoutEvents,
  companyPersonDiscoveries,
  enrichmentSnapshots,
  enrichmentChangeEvents,
  enrichmentIdentities,
  enrichmentCaptureRuns,
  evidenceLedger,
} = schema;

type Json = Record<string, unknown>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const CANDIDATE_PAGE_SIZE = 15;
export const EVIDENCE_SCHEMA_VERSION = 1;

// ── Evidence facts ────────────────────────────────────────────────────────────

export interface EvidenceFact {
  evidenceId: string;
  attribute: string;
  value: unknown;
  source: string;
  sourceUrl: string | null;
  /** When the fact was seen on its source page. */
  observedAt: string;
  /** When Skout last captured it. */
  capturedAt: string;
  confidence: number;
  state: "verified" | "discovery" | "unverified";
  method: string | null;
  freshnessExpiresAt: string | null;
  stale: boolean;
  /** Verified and fresh: safe to state as a fact in a draft. Anything else needs hedging or review. */
  usableForClaims: boolean;
}

type EvidenceRow = typeof evidenceLedger.$inferSelect;

function toFact(row: EvidenceRow, now = Date.now()): EvidenceFact {
  const state = row.validation === "verified" || row.validation === "discovery" ? row.validation : "unverified";
  const stale = row.freshnessExpiresAt ? row.freshnessExpiresAt.getTime() < now : false;
  return {
    evidenceId: row.id,
    attribute: row.attribute,
    value: row.value,
    source: row.source,
    sourceUrl: row.sourceUrl,
    observedAt: row.observedAt.toISOString(),
    capturedAt: row.retrievedAt.toISOString(),
    confidence: row.confidence,
    state,
    method: row.method,
    freshnessExpiresAt: row.freshnessExpiresAt?.toISOString() ?? null,
    stale,
    usableForClaims: state === "verified" && !stale,
  };
}

const STATE_RANK = { verified: 2, discovery: 1, unverified: 0 } as const;

/** One fact per attribute: a verified observation beats a discovery card, then the newest wins. */
export function currentFacts(rows: EvidenceRow[]): EvidenceFact[] {
  const best = new Map<string, EvidenceFact>();
  for (const row of rows) {
    const fact = toFact(row);
    const held = best.get(fact.attribute);
    if (
      !held ||
      STATE_RANK[fact.state] > STATE_RANK[held.state] ||
      (STATE_RANK[fact.state] === STATE_RANK[held.state] && fact.observedAt > held.observedAt)
    ) {
      best.set(fact.attribute, fact);
    }
  }
  return [...best.values()].sort((a, b) => a.attribute.localeCompare(b.attribute));
}

async function evidenceRows(db: Db, workspaceId: string, entityType: string, entityId: string): Promise<EvidenceRow[]> {
  return db
    .select()
    .from(evidenceLedger)
    .where(and(eq(evidenceLedger.workspaceId, workspaceId), eq(evidenceLedger.entityType, entityType), eq(evidenceLedger.entityId, entityId)))
    .orderBy(desc(evidenceLedger.observedAt))
    .limit(500);
}

// ── People ────────────────────────────────────────────────────────────────────

export interface PersonSummary {
  prospectId: string;
  contactId: string | null;
  fullName: string | null;
  headline: string | null;
  title: string | null;
  companyId: string | null;
  companyName: string | null;
  location: string | null;
  /** A real public profile URL, or null. Never derived from a Sales lead id. */
  linkedinUrl: string | null;
  salesNavigatorLeadUrl: string | null;
  identity: "public_profile" | "sales_lead" | "none";
  employmentState: "verified" | "candidate" | "unknown";
  seniority: string | null;
  jobFunction: string | null;
  captureSource: string | null;
  sourceUrl: string | null;
  capturedAt: string;
  /** Registered by URL only; no profile content has been captured yet. */
  pendingCapture: boolean;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function toPersonSummary(row: {
  prospectId: string;
  snapshot: unknown;
  updatedAt: Date;
  contactId: string | null;
  contactTitle: string | null;
  contactLinkedinUrl: string | null;
  employmentStatus: string | null;
  companyId: string | null;
  companyName: string | null;
}): PersonSummary {
  const snapshot = (row.snapshot ?? {}) as Json;
  const publicUrl = [text(snapshot.linkedinUrl), row.contactLinkedinUrl].find((url) => url && publicIdFromProfileUrl(url)) ?? null;
  const salesNavigatorLeadUrl = text(snapshot.salesNavigatorLeadUrl);
  const fullName = text(snapshot.fullName);
  return {
    prospectId: row.prospectId,
    contactId: row.contactId,
    fullName,
    headline: text(snapshot.headline),
    title: text(snapshot.title) ?? row.contactTitle,
    companyId: row.companyId,
    companyName: row.companyName ?? text(snapshot.companyName),
    location: text(snapshot.location) ?? text(snapshot.locationName),
    linkedinUrl: publicUrl,
    salesNavigatorLeadUrl,
    identity: publicUrl ? "public_profile" : salesNavigatorLeadUrl ? "sales_lead" : "none",
    employmentState:
      row.employmentStatus === "verified_employment" && row.companyId ? "verified" : row.companyId || text(snapshot.companyName) ? "candidate" : "unknown",
    seniority: text(snapshot.seniority),
    jobFunction: text(snapshot.jobFunction),
    captureSource: text(snapshot.captureSource),
    sourceUrl: text(snapshot.sourceUrl),
    capturedAt: text(snapshot.capturedAt) ?? row.updatedAt.toISOString(),
    pendingCapture: !fullName,
  };
}

export interface PeopleFilters {
  q?: string;
  state?: "verified" | "candidate";
  identity?: "public_profile" | "sales_lead";
  companyId?: string;
  department?: string;
  seniority?: string;
  page: number;
  pageSize: number;
}

const like = (value: string) => `%${value.trim().replace(/[\\%_]/g, "\\$&")}%`;
const snap = (key: string) => sql`${prospectActivations.snapshot}->>${key}`;
const PUBLIC_URL_SQL = sql`(${contacts.linkedinUrl} ~* 'linkedin\\.com/in/[^/]+' or ${snap("linkedinUrl")} ~* 'linkedin\\.com/in/[^/]+')`;
const VERIFIED_SQL = sql`(${contacts.employmentStatus} = 'verified_employment' and ${contacts.companyId} is not null)`;

function personFilters(filters: Omit<PeopleFilters, "page" | "pageSize">): SQL[] {
  const where: SQL[] = [];
  if (filters.q?.trim()) {
    const pattern = like(filters.q);
    where.push(
      sql`(${snap("fullName")} ilike ${pattern} or ${snap("headline")} ilike ${pattern} or ${snap("title")} ilike ${pattern} or ${snap("companyName")} ilike ${pattern} or ${companies.name} ilike ${pattern})`
    );
  }
  if (filters.state === "verified") where.push(VERIFIED_SQL);
  if (filters.state === "candidate") where.push(sql`not coalesce(${VERIFIED_SQL}, false)`);
  if (filters.identity === "public_profile") where.push(PUBLIC_URL_SQL);
  if (filters.identity === "sales_lead") {
    where.push(sql`(${snap("salesNavigatorLeadUrl")} is not null and not coalesce(${PUBLIC_URL_SQL}, false))`);
  }
  if (filters.companyId) where.push(eq(contacts.companyId, filters.companyId));
  if (filters.department?.trim()) {
    const pattern = like(filters.department);
    where.push(sql`(${snap("jobFunction")} ilike ${pattern} or ${snap("title")} ilike ${pattern} or ${snap("headline")} ilike ${pattern})`);
  }
  if (filters.seniority?.trim()) {
    const pattern = like(filters.seniority);
    where.push(sql`(${snap("seniority")} ilike ${pattern} or ${snap("title")} ilike ${pattern} or ${snap("headline")} ilike ${pattern})`);
  }
  return where;
}

const personColumns = {
  prospectId: prospectActivations.prospectId,
  snapshot: prospectActivations.snapshot,
  updatedAt: prospectActivations.updatedAt,
  contactId: contacts.id,
  contactTitle: contacts.title,
  contactLinkedinUrl: contacts.linkedinUrl,
  employmentStatus: contacts.employmentStatus,
  companyId: companies.id,
  companyName: companies.name,
};

/** People = workspace prospect activations, joined to their CRM contact and current company. */
function peopleFrom<T extends { from: (table: typeof prospectActivations) => any }>(query: T) {
  return query
    .from(prospectActivations)
    .leftJoin(
      contacts,
      and(
        eq(contacts.workspaceId, prospectActivations.workspaceId),
        eq(contacts.sourceProspectId, prospectActivations.prospectId),
        isNull(contacts.deletedAt)
      )
    )
    .leftJoin(companies, and(eq(companies.id, contacts.companyId), isNull(companies.deletedAt)));
}

export async function listPeople(db: Db, workspaceId: string, filters: PeopleFilters) {
  const where = and(eq(prospectActivations.workspaceId, workspaceId), ...personFilters(filters));
  const [totals] = await peopleFrom(db.select({ total: count() })).where(where);
  const rows = await peopleFrom(db.select(personColumns))
    .where(where)
    .orderBy(desc(prospectActivations.updatedAt), prospectActivations.prospectId)
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);
  return {
    people: (rows as Parameters<typeof toPersonSummary>[0][]).map(toPersonSummary),
    total: Number((totals as { total: number } | undefined)?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function getPerson(db: Db, workspaceId: string, prospectId: string) {
  const [row] = await peopleFrom(db.select(personColumns))
    .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)))
    .limit(1);
  if (!row) return null;
  const summary = toPersonSummary(row as Parameters<typeof toPersonSummary>[0]);
  const snapshot = ((row as { snapshot: unknown }).snapshot ?? {}) as Json;
  const list = (key: string) => (Array.isArray(snapshot[key]) ? (snapshot[key] as unknown[]) : []);

  const [rows, changes, candidateCompanies, identityKeys] = await Promise.all([
    evidenceRows(db, workspaceId, "prospect", prospectId),
    db
      .select()
      .from(enrichmentChangeEvents)
      .where(
        and(
          eq(enrichmentChangeEvents.workspaceId, workspaceId),
          eq(enrichmentChangeEvents.entityType, "person"),
          eq(enrichmentChangeEvents.entityId, prospectId)
        )
      )
      .orderBy(desc(enrichmentChangeEvents.detectedAt))
      .limit(50),
    summary.contactId
      ? db
          .select({
            companyId: companies.id,
            companyName: companies.name,
            source: companyPersonDiscoveries.source,
            capturedAt: companyPersonDiscoveries.capturedAt,
          })
          .from(companyPersonDiscoveries)
          .innerJoin(companies, eq(companies.id, companyPersonDiscoveries.companyId))
          .where(and(eq(companyPersonDiscoveries.workspaceId, workspaceId), eq(companyPersonDiscoveries.contactId, summary.contactId)))
      : Promise.resolve([]),
    summary.contactId
      ? db
          .select({ key: enrichmentIdentities.canonicalKey })
          .from(enrichmentIdentities)
          .where(
            and(
              eq(enrichmentIdentities.workspaceId, workspaceId),
              eq(enrichmentIdentities.entityType, "person"),
              eq(enrichmentIdentities.entityId, summary.contactId)
            )
          )
      : Promise.resolve([]),
  ]);

  const facts = currentFacts(rows);
  return {
    ...summary,
    summary: text(snapshot.summary) ?? text(snapshot.about),
    connectionsCount: typeof snapshot.connectionsCount === "number" ? snapshot.connectionsCount : null,
    followersCount: typeof snapshot.followersCount === "number" ? snapshot.followersCount : null,
    relationshipContext: (snapshot.relationshipContext as Json | undefined) ?? null,
    experience: { current: list("currentCompanies"), previous: list("previousCompanies") },
    educations: list("educations"),
    skills: list("skills"),
    certifications: list("certifications"),
    languages: list("languages"),
    recommendations: list("recommendations"),
    volunteerExperiences: list("volunteerExperiences"),
    honors: list("honors"),
    publications: list("publications"),
    /** Company the enrich action needs; a capture placeholder when no real domain is known. */
    companyDomain: text(snapshot.companyDomain),
    identityKeys: identityKeys.map((identity) => identity.key),
    candidateCompanies: candidateCompanies.map((item) => ({ ...item, capturedAt: item.capturedAt.toISOString() })),
    facts,
    evidence: rows.slice(0, 100).map((evidence) => toFact(evidence)),
    changes: changes.map(toChange),
    freshness: {
      capturedAt: summary.capturedAt,
      stale: facts.length > 0 && facts.every((fact) => fact.stale),
    },
  };
}

type ChangeRow = typeof enrichmentChangeEvents.$inferSelect;

function toChange(row: ChangeRow) {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    field: row.field,
    changeType: row.changeType,
    oldValue: row.oldValue,
    newValue: row.newValue,
    isJobChange: row.isJobChange,
    detectedAt: row.detectedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedBy: row.reviewedBy,
  };
}

// ── Companies ─────────────────────────────────────────────────────────────────

async function companyPeopleCounts(db: Db, workspaceId: string, companyIds: string[]) {
  if (!companyIds.length) return new Map<string, { verified: number; candidates: number }>();
  const [verified, discovered] = await Promise.all([
    db
      .select({ companyId: contacts.companyId, total: count() })
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, workspaceId),
          inArray(contacts.companyId, companyIds),
          eq(contacts.employmentStatus, "verified_employment"),
          isNull(contacts.deletedAt)
        )
      )
      .groupBy(contacts.companyId),
    db
      .select({ companyId: companyPersonDiscoveries.companyId, total: count() })
      .from(companyPersonDiscoveries)
      .innerJoin(contacts, and(eq(contacts.id, companyPersonDiscoveries.contactId), isNull(contacts.deletedAt)))
      .where(
        and(
          eq(companyPersonDiscoveries.workspaceId, workspaceId),
          inArray(companyPersonDiscoveries.companyId, companyIds),
          sql`not (${contacts.employmentStatus} = 'verified_employment' and ${contacts.companyId} = ${companyPersonDiscoveries.companyId})`
        )
      )
      .groupBy(companyPersonDiscoveries.companyId),
  ]);
  const counts = new Map(companyIds.map((id) => [id, { verified: 0, candidates: 0 }]));
  for (const row of verified) if (row.companyId) counts.get(row.companyId)!.verified = Number(row.total);
  for (const row of discovered) counts.get(row.companyId)!.candidates = Number(row.total);
  return counts;
}

export async function listCompanies(db: Db, workspaceId: string, filters: { q?: string; page: number; pageSize: number }) {
  const where = and(
    eq(companies.workspaceId, workspaceId),
    isNull(companies.deletedAt),
    ...(filters.q?.trim()
      ? [sql`(${companies.name} ilike ${like(filters.q)} or ${companies.domain} ilike ${like(filters.q)} or ${companies.industry} ilike ${like(filters.q)})`]
      : [])
  );
  const [totals] = await db.select({ total: count() }).from(companies).where(where);
  const rows = await db
    .select()
    .from(companies)
    .where(where)
    .orderBy(desc(companies.updatedAt), companies.id)
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);
  const counts = await companyPeopleCounts(db, workspaceId, rows.map((row) => row.id));
  return {
    companies: rows.map((row) => {
      const people = counts.get(row.id)!;
      return {
        ...row,
        verifiedEmployees: people.verified,
        discoveryCandidates: people.candidates,
        // ENR-01 response shape, kept for existing consumers.
        _count: { employees: people.verified + people.candidates },
      };
    }),
    total: Number(totals?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

async function loadCompany(db: Db, workspaceId: string, companyId: string) {
  const [company] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)))
    .limit(1);
  return company ?? null;
}

function associatedMemberCount(capture: Json): number | null {
  if (typeof capture.employeesOnLi === "number") return capture.employeesOnLi;
  const stats = capture.peopleStats as { totalEmployeesText?: unknown } | undefined;
  const match = typeof stats?.totalEmployeesText === "string" ? stats.totalEmployeesText.match(/([\d,]+)\s+associated members/i) : null;
  return match ? Number(match[1]!.replace(/,/g, "")) || null : null;
}

export async function getCompany(db: Db, workspaceId: string, companyId: string) {
  const company = await loadCompany(db, workspaceId, companyId);
  if (!company) return null;
  const [rows, [snapshot], changes, identityKeys, counts] = await Promise.all([
    evidenceRows(db, workspaceId, "company", companyId),
    db
      .select({ rawData: enrichmentSnapshots.rawData, capturedAt: enrichmentSnapshots.capturedAt })
      .from(enrichmentSnapshots)
      .where(
        and(eq(enrichmentSnapshots.workspaceId, workspaceId), eq(enrichmentSnapshots.entityType, "company"), eq(enrichmentSnapshots.entityId, companyId))
      )
      .orderBy(desc(enrichmentSnapshots.capturedAt))
      .limit(1),
    db
      .select()
      .from(enrichmentChangeEvents)
      .where(
        and(
          eq(enrichmentChangeEvents.workspaceId, workspaceId),
          eq(enrichmentChangeEvents.entityType, "company"),
          eq(enrichmentChangeEvents.entityId, companyId)
        )
      )
      .orderBy(desc(enrichmentChangeEvents.detectedAt))
      .limit(50),
    db
      .select({ key: enrichmentIdentities.canonicalKey })
      .from(enrichmentIdentities)
      .where(
        and(eq(enrichmentIdentities.workspaceId, workspaceId), eq(enrichmentIdentities.entityType, "company"), eq(enrichmentIdentities.entityId, companyId))
      ),
    companyPeopleCounts(db, workspaceId, [companyId]),
  ]);
  const capture = (snapshot?.rawData ?? {}) as Json;
  const facts = currentFacts(rows);
  const publicKey = identityKeys.map((identity) => identity.key).find((key) => key.startsWith("company:"));
  return {
    ...company,
    linkedinUrl: publicKey ? `https://www.linkedin.com/company/${publicKey.slice("company:".length)}/` : null,
    identityKeys: identityKeys.map((identity) => identity.key),
    capture: {
      capturedAt: snapshot?.capturedAt.toISOString() ?? null,
      sourceUrl: text(capture.sourceUrl),
      tagline: text(capture.tagline),
      overview: text(capture.overview),
      website: text(capture.website),
      size: text(capture.size),
      headquarter: text(capture.headquarter),
      foundedAt: text(capture.foundedAt),
      specialties: Array.isArray(capture.specialties) ? capture.specialties : [],
      followers: typeof capture.followers === "number" ? capture.followers : null,
      openJobs: Array.isArray(capture.openJobs) ? capture.openJobs.length : 0,
      sections: Object.keys((capture.sectionCaptures as Json | undefined) ?? {}),
    },
    people: {
      /** The member count LinkedIn displayed; not a count of obtainable records. */
      visibleAssociatedMembers: associatedMemberCount(capture),
      verifiedEmployees: counts.get(companyId)!.verified,
      discoveryCandidates: counts.get(companyId)!.candidates,
    },
    facts,
    evidence: rows.slice(0, 100).map((evidence) => toFact(evidence)),
    changes: changes.map(toChange),
    freshness: { capturedAt: snapshot?.capturedAt.toISOString() ?? null, stale: facts.length > 0 && facts.every((fact) => fact.stale) },
  };
}

export interface CompanyPeopleFilters extends Omit<PeopleFilters, "state" | "companyId"> {
  group: "verified" | "candidates";
}

/**
 * People at a company, in two groups that never mix: employees verified from their own
 * profile, and candidates discovered on search or people cards.
 */
export async function listCompanyPeople(db: Db, workspaceId: string, companyId: string, filters: CompanyPeopleFilters) {
  if (!(await loadCompany(db, workspaceId, companyId))) return null;
  const shared = personFilters(filters);
  const offset = (filters.page - 1) * filters.pageSize;

  if (filters.group === "verified") {
    const where = and(eq(prospectActivations.workspaceId, workspaceId), eq(contacts.companyId, companyId), VERIFIED_SQL, ...shared);
    const [totals] = await peopleFrom(db.select({ total: count() })).where(where);
    const rows = await peopleFrom(db.select(personColumns))
      .where(where)
      .orderBy(snap("fullName"), prospectActivations.prospectId)
      .limit(filters.pageSize)
      .offset(offset);
    return {
      group: filters.group,
      people: (rows as Parameters<typeof toPersonSummary>[0][]).map((row) => ({ ...toPersonSummary(row), discoverySource: null, discoveredAt: null })),
      total: Number((totals as { total: number } | undefined)?.total ?? 0),
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  const from = <T extends { from: (table: typeof companyPersonDiscoveries) => any }>(query: T) =>
    query
      .from(companyPersonDiscoveries)
      .innerJoin(contacts, and(eq(contacts.id, companyPersonDiscoveries.contactId), isNull(contacts.deletedAt)))
      .innerJoin(
        prospectActivations,
        and(eq(prospectActivations.workspaceId, contacts.workspaceId), eq(prospectActivations.prospectId, contacts.sourceProspectId))
      )
      .leftJoin(companies, and(eq(companies.id, contacts.companyId), isNull(companies.deletedAt)));
  const where = and(
    eq(companyPersonDiscoveries.workspaceId, workspaceId),
    eq(companyPersonDiscoveries.companyId, companyId),
    sql`not (${contacts.employmentStatus} = 'verified_employment' and ${contacts.companyId} = ${companyPersonDiscoveries.companyId})`,
    ...shared
  );
  const [totals] = await from(db.select({ total: count() })).where(where);
  const rows = await from(
    db.select({ ...personColumns, discoverySource: companyPersonDiscoveries.source, discoveredAt: companyPersonDiscoveries.capturedAt })
  )
    .where(where)
    .orderBy(snap("fullName"), prospectActivations.prospectId)
    .limit(filters.pageSize)
    .offset(offset);
  return {
    group: filters.group,
    people: (rows as (Parameters<typeof toPersonSummary>[0] & { discoverySource: string; discoveredAt: Date })[]).map((row) => ({
      ...toPersonSummary(row),
      // Listed under this company as a candidate, whatever employer the contact record holds.
      employmentState: "candidate" as const,
      discoverySource: row.discoverySource,
      discoveredAt: row.discoveredAt.toISOString(),
    })),
    total: Number((totals as { total: number } | undefined)?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

// ── Job changes ───────────────────────────────────────────────────────────────

function roleOf(value: unknown): { company: string | null; title: string | null } {
  const role = Array.isArray(value) ? (value[0] as Json | undefined) : undefined;
  return { company: text(role?.name), title: text(role?.title) };
}

export async function listJobChanges(
  db: Db,
  workspaceId: string,
  filters: { status: "pending" | "reviewed" | "all"; page: number; pageSize: number }
) {
  const where = and(
    eq(enrichmentChangeEvents.workspaceId, workspaceId),
    eq(enrichmentChangeEvents.isJobChange, true),
    ...(filters.status === "pending" ? [isNull(enrichmentChangeEvents.reviewedAt)] : []),
    ...(filters.status === "reviewed" ? [isNotNull(enrichmentChangeEvents.reviewedAt)] : [])
  );
  const [totals] = await db.select({ total: count() }).from(enrichmentChangeEvents).where(where);
  const rows = await db
    .select({ change: enrichmentChangeEvents, snapshot: prospectActivations.snapshot })
    .from(enrichmentChangeEvents)
    .leftJoin(
      prospectActivations,
      and(eq(prospectActivations.workspaceId, enrichmentChangeEvents.workspaceId), eq(prospectActivations.prospectId, enrichmentChangeEvents.entityId))
    )
    .where(where)
    .orderBy(desc(enrichmentChangeEvents.detectedAt))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);
  return {
    jobChanges: rows.map(({ change, snapshot }) => {
      const person = (snapshot ?? {}) as Json;
      return {
        ...toChange(change),
        prospectId: change.entityId,
        fullName: text(person.fullName),
        sourceUrl: text(person.sourceUrl) ?? text(person.linkedinUrl),
        from: roleOf(change.oldValue),
        to: roleOf(change.newValue),
        requiresReview: !change.reviewedAt,
        // A detected change is surfaced for a person to review. It starts no outreach.
        automation: "none" as const,
      };
    }),
    total: Number(totals?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function reviewJobChange(db: Db, actor: CaptureActor, changeId: string) {
  const [updated] = await db
    .update(enrichmentChangeEvents)
    .set({ reviewedAt: new Date(), reviewedBy: actor.userId })
    .where(
      and(
        eq(enrichmentChangeEvents.id, changeId),
        eq(enrichmentChangeEvents.workspaceId, actor.workspaceId),
        eq(enrichmentChangeEvents.isJobChange, true),
        isNull(enrichmentChangeEvents.reviewedAt)
      )
    )
    .returning();
  if (updated) return toChange(updated);
  const [existing] = await db
    .select()
    .from(enrichmentChangeEvents)
    .where(and(eq(enrichmentChangeEvents.id, changeId), eq(enrichmentChangeEvents.workspaceId, actor.workspaceId), eq(enrichmentChangeEvents.isJobChange, true)))
    .limit(1);
  return existing ? toChange(existing) : null;
}

// ── Overview ──────────────────────────────────────────────────────────────────

export async function getOverview(db: Db, workspaceId: string) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [[people], [companyTotals], [jobChanges], [runs]] = await Promise.all([
    peopleFrom(
      db.select({
        total: count(),
        verified: sql<number>`count(*) filter (where ${VERIFIED_SQL})::int`,
        publicProfiles: sql<number>`count(*) filter (where ${PUBLIC_URL_SQL})::int`,
        salesLeads: sql<number>`count(*) filter (where ${snap("salesNavigatorLeadUrl")} is not null and not coalesce(${PUBLIC_URL_SQL}, false))::int`,
      })
    ).where(eq(prospectActivations.workspaceId, workspaceId)),
    db.select({ total: count() }).from(companies).where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))),
    db
      .select({ pending: count() })
      .from(enrichmentChangeEvents)
      .where(
        and(eq(enrichmentChangeEvents.workspaceId, workspaceId), eq(enrichmentChangeEvents.isJobChange, true), isNull(enrichmentChangeEvents.reviewedAt))
      ),
    db
      .select({
        total: count(),
        leads: sql<number>`coalesce(sum(${enrichmentCaptureRuns.leadsReceived} - ${enrichmentCaptureRuns.leadsRejected}), 0)::int`,
      })
      .from(enrichmentCaptureRuns)
      .where(and(eq(enrichmentCaptureRuns.workspaceId, workspaceId), gte(enrichmentCaptureRuns.startedAt, weekAgo))),
  ]);
  const totals = people as { total: number; verified: number; publicProfiles: number; salesLeads: number } | undefined;
  const total = Number(totals?.total ?? 0);
  const verified = Number(totals?.verified ?? 0);
  return {
    people: {
      total,
      verifiedEmployment: verified,
      discoveryCandidates: total - verified,
      publicProfiles: Number(totals?.publicProfiles ?? 0),
      salesNavigatorOnly: Number(totals?.salesLeads ?? 0),
    },
    companies: { total: Number(companyTotals?.total ?? 0) },
    jobChanges: { pendingReview: Number(jobChanges?.pending ?? 0) },
    captures: { runsLast7Days: Number(runs?.total ?? 0), leadsLast7Days: Number(runs?.leads ?? 0) },
  };
}

// ── ProspectEvidence / AccountEvidence (stable read contract for sequence drafting) ───────────

export async function getProspectEvidence(db: Db, workspaceId: string, prospectId: string) {
  const [row] = await peopleFrom(db.select(personColumns))
    .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)))
    .limit(1);
  if (!row) return null;
  const person = toPersonSummary(row as Parameters<typeof toPersonSummary>[0]);
  const facts = currentFacts(await evidenceRows(db, workspaceId, "prospect", prospectId));
  const employmentFact = facts.find((fact) => fact.attribute === "employment");
  const employment = employmentFact?.value as { companyId?: string | null; companyName?: string | null; title?: string | null } | undefined;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "ProspectEvidence" as const,
    workspaceId,
    prospectId,
    contactId: person.contactId,
    identity: {
      state: person.identity,
      linkedinUrl: person.linkedinUrl,
      salesNavigatorLeadUrl: person.salesNavigatorLeadUrl,
    },
    employment: employmentFact
      ? {
          state: employmentFact.state,
          companyId: employment?.companyId ?? null,
          companyName: employment?.companyName ?? null,
          title: employment?.title ?? null,
          sourceUrl: employmentFact.sourceUrl,
          observedAt: employmentFact.observedAt,
          confidence: employmentFact.confidence,
          usableForClaims: employmentFact.usableForClaims,
        }
      : null,
    facts,
    generatedAt: new Date().toISOString(),
  };
}

export async function getAccountEvidence(db: Db, workspaceId: string, companyId: string) {
  const company = await getCompany(db, workspaceId, companyId);
  if (!company) return null;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "AccountEvidence" as const,
    workspaceId,
    companyId,
    name: company.name,
    domain: company.domain,
    linkedinUrl: company.linkedinUrl,
    people: company.people,
    facts: company.facts,
    generatedAt: new Date().toISOString(),
  };
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function removeFromLists(tx: Tx, workspaceId: string, prospectIds: string[]) {
  if (!prospectIds.length) return;
  const workspaceLists = await tx.select({ id: lists.id }).from(lists).where(eq(lists.workspaceId, workspaceId));
  if (!workspaceLists.length) return;
  await tx
    .delete(listMembers)
    .where(and(inArray(listMembers.listId, workspaceLists.map((list) => list.id)), inArray(listMembers.prospectId, prospectIds)));
}

export interface DeleteResult {
  deletedId: string;
  evidenceRemoved: number;
  /** False when the CRM contact existed before capture and was kept (unlinked from the capture). */
  contactRemoved: boolean;
}

/**
 * Deletes a captured person and everything derived from the capture: identity keys, evidence,
 * snapshots, change history, discovery edges, jobs and list memberships. The CRM contact is
 * removed only when the capture created it; a contact that already existed keeps its CRM data.
 */
export async function deletePerson(db: Db, actor: CaptureActor, prospectId: string): Promise<DeleteResult | null> {
  const { workspaceId } = actor;
  return db.transaction(async (tx) => {
    const [activation] = await tx
      .select({ prospectId: prospectActivations.prospectId })
      .from(prospectActivations)
      .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)))
      .limit(1);
    if (!activation) return null;

    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.sourceProspectId, prospectId), isNull(contacts.deletedAt)))
      .limit(1);

    let evidenceRemoved = await deleteCaptureEvidence(tx, workspaceId, "prospect", [prospectId]);
    let contactRemoved = false;
    if (contact) {
      const identities = await tx
        .delete(enrichmentIdentities)
        .where(
          and(eq(enrichmentIdentities.workspaceId, workspaceId), eq(enrichmentIdentities.entityType, "person"), eq(enrichmentIdentities.entityId, contact.id))
        )
        .returning({ key: enrichmentIdentities.canonicalKey });
      await tx
        .delete(companyPersonDiscoveries)
        .where(and(eq(companyPersonDiscoveries.workspaceId, workspaceId), eq(companyPersonDiscoveries.contactId, contact.id)));
      evidenceRemoved += await deleteCaptureEvidence(tx, workspaceId, "contact", [contact.id]);

      const captureCreated = identities.some((identity) => prospectIdForCanonicalKey(identity.key) === prospectId);
      if (captureCreated && !contact.email && !contact.phone && contact.lifecycleStage === "lead") {
        await tx
          .update(contacts)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contact.id)));
        contactRemoved = true;
      } else {
        await tx
          .update(contacts)
          .set({ sourceProspectId: null, updatedAt: new Date() })
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contact.id)));
      }
    }

    await tx
      .delete(enrichmentChangeEvents)
      .where(
        and(eq(enrichmentChangeEvents.workspaceId, workspaceId), eq(enrichmentChangeEvents.entityType, "person"), eq(enrichmentChangeEvents.entityId, prospectId))
      );
    await tx
      .delete(enrichmentSnapshots)
      .where(and(eq(enrichmentSnapshots.workspaceId, workspaceId), eq(enrichmentSnapshots.entityType, "person"), eq(enrichmentSnapshots.entityId, prospectId)));
    await tx.delete(skoutEvents).where(and(eq(skoutEvents.workspaceId, workspaceId), eq(skoutEvents.aggregateId, prospectId)));
    await tx
      .delete(asyncJobs)
      .where(and(eq(asyncJobs.workspaceId, workspaceId), eq(asyncJobs.entityType, "prospect"), eq(asyncJobs.entityId, prospectId)));
    await tx.delete(enrichmentJobs).where(and(eq(enrichmentJobs.workspaceId, workspaceId), eq(enrichmentJobs.prospectId, prospectId)));
    await removeFromLists(tx, workspaceId, [prospectId]);
    await tx
      .delete(prospectActivations)
      .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)));

    await recordPrivilegedAction(tx, {
      workspaceId,
      actorId: actor.userId,
      action: "enrichment.delete",
      entityType: "person",
      entityId: contact?.id ?? actor.workspaceId,
      beforeState: { prospectId, contactId: contact?.id ?? null },
      afterState: { deleted: true, evidenceRemoved, contactRemoved },
    });
    return { deletedId: prospectId, evidenceRemoved, contactRemoved };
  });
}

/**
 * Deletes a company with its capture-derived data. People stay as records; their link to this
 * company (employer and candidate edges) is removed.
 */
export async function deleteCompany(db: Db, actor: CaptureActor, companyId: string): Promise<DeleteResult | null> {
  const { workspaceId } = actor;
  return db.transaction(async (tx) => {
    const [company] = await tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)))
      .limit(1);
    if (!company) return null;

    const evidenceRemoved = await deleteCaptureEvidence(tx, workspaceId, "company", [companyId]);
    await tx
      .delete(enrichmentIdentities)
      .where(and(eq(enrichmentIdentities.workspaceId, workspaceId), eq(enrichmentIdentities.entityType, "company"), eq(enrichmentIdentities.entityId, companyId)));
    await tx
      .delete(enrichmentChangeEvents)
      .where(
        and(eq(enrichmentChangeEvents.workspaceId, workspaceId), eq(enrichmentChangeEvents.entityType, "company"), eq(enrichmentChangeEvents.entityId, companyId))
      );
    await tx
      .delete(enrichmentSnapshots)
      .where(and(eq(enrichmentSnapshots.workspaceId, workspaceId), eq(enrichmentSnapshots.entityType, "company"), eq(enrichmentSnapshots.entityId, companyId)));
    await tx
      .delete(companyPersonDiscoveries)
      .where(and(eq(companyPersonDiscoveries.workspaceId, workspaceId), eq(companyPersonDiscoveries.companyId, companyId)));
    await tx.delete(skoutEvents).where(and(eq(skoutEvents.workspaceId, workspaceId), eq(skoutEvents.aggregateId, companyId)));
    await tx
      .delete(asyncJobs)
      .where(and(eq(asyncJobs.workspaceId, workspaceId), eq(asyncJobs.entityType, "company"), eq(asyncJobs.entityId, companyId)));
    // Nobody stays "verified" at a company that no longer exists.
    await tx
      .update(contacts)
      .set({ companyId: null, employmentStatus: "discovery_candidate", updatedAt: new Date() })
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.companyId, companyId)));
    await recordPrivilegedAction(tx, {
      workspaceId,
      actorId: actor.userId,
      action: "enrichment.delete",
      entityType: "company",
      entityId: companyId,
      beforeState: { companyId, name: company.name },
      afterState: { deleted: true, evidenceRemoved },
    });
    await tx.delete(companies).where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)));
    return { deletedId: companyId, evidenceRemoved, contactRemoved: false };
  });
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  // A leading =, +, - or @ would be run as a formula by a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  return [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
}

export const PEOPLE_CSV_COLUMNS = [
  "prospectId",
  "fullName",
  "headline",
  "title",
  "companyName",
  "location",
  "employmentState",
  "identity",
  "linkedinUrl",
  "salesNavigatorLeadUrl",
  "captureSource",
  "sourceUrl",
  "capturedAt",
];

/** Every person matching the filters, up to `limit`, for CSV export. */
export async function exportPeopleRows(db: Db, workspaceId: string, filters: Omit<PeopleFilters, "page" | "pageSize">, limit = 5_000) {
  return (await listPeople(db, workspaceId, { ...filters, page: 1, pageSize: limit })).people;
}

export async function exportCompanyPeopleRows(db: Db, workspaceId: string, companyId: string) {
  const groups = await Promise.all(
    (["verified", "candidates"] as const).map((group) => listCompanyPeople(db, workspaceId, companyId, { group, page: 1, pageSize: 5_000 }))
  );
  if (groups.some((group) => group === null)) return null;
  return groups.flatMap((group) => group!.people.map((person) => ({ ...person, group: group!.group })));
}

export { CaptureError };
