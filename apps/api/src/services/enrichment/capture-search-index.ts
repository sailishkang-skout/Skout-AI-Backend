// LinkedIn profile captures in Search & Discover. Each captured person is indexed into the shared
// prospect search index, so every workspace finds them by name, headline, company, role, past
// company, school, skill or location. One document per person: a re-capture from any workspace
// refreshes it.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import {
  bulkUpsertProspects,
  ensureCaptureFieldMappings,
  type OpenSearchConfig,
  type ProspectDocument,
} from "@skout/opensearch";
import { LINKEDIN_CAPTURE_SOURCE } from "../search.service.js";

const { prospectActivations } = schema;

type Json = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const list = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object") : [];
const names = (values: unknown, key: string): string[] | undefined => {
  const out = [...new Set(list(values).map((item) => str(item[key])).filter((v): v is string => !!v))];
  return out.length ? out : undefined;
};

/** True when a prospect snapshot came from a LinkedIn profile capture. */
export function isLinkedinCapture(snapshot: Json): boolean {
  return snapshot.captureSource === "linkedin-public-profile" || !!str(snapshot.linkedinPublicId);
}

/** Search document for one captured person, built from the saved prospect snapshot. */
export function capturedPersonDocument(
  prospectId: string,
  companyId: string,
  snapshot: Json,
  updatedAt: Date = new Date()
): ProspectDocument {
  const current = list(snapshot.currentCompanies)[0];
  const location = str(snapshot.locationName) ?? str(snapshot.location);
  const parts = (location ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const doc: ProspectDocument = {
    prospectId,
    companyId,
    dataSource: LINKEDIN_CAPTURE_SOURCE,
    fullName: str(snapshot.fullName),
    title: str(snapshot.title) ?? str(current?.title),
    headline: str(snapshot.headline),
    seniority: str(snapshot.seniority)?.toLowerCase(),
    jobFunction: str(snapshot.jobFunction),
    email: str(snapshot.email),
    phone: str(snapshot.phone),
    linkedinUrl: str(snapshot.linkedinUrl),
    companyDomain: str(snapshot.companyDomain) ?? "",
    companyName: str(snapshot.companyName) ?? str(current?.name),
    previousCompany: names(snapshot.previousCompanies, "name")?.join(", "),
    location,
    city: parts.length > 1 ? parts[0] : undefined,
    country: str(snapshot.locationCountry) ?? (parts.length > 1 ? parts[parts.length - 1] : undefined),
    skills: names(snapshot.skills, "name"),
    schools: names(snapshot.educations, "school"),
    updatedAt: updatedAt.toISOString(),
  };
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)) as ProspectDocument;
}

let mappingsReady: Promise<void> | null = null;

/**
 * Indexes captured people: the given prospects, or every captured profile when `prospectIds` is
 * omitted (backfill). Captures are shared across workspaces, so `workspaceId` may be null to
 * cover every workspace (the global backfill). Returns how many documents were written.
 */
export async function indexCapturedPeople(
  db: Db,
  cfg: OpenSearchConfig,
  workspaceId: string | null,
  prospectIds?: string[]
): Promise<{ indexed: number; failed: number }> {
  if (prospectIds && !prospectIds.length) return { indexed: 0, failed: 0 };
  mappingsReady ??= ensureCaptureFieldMappings(cfg).catch((error) => {
    mappingsReady = null;
    throw error;
  });
  await mappingsReady;

  let indexed = 0;
  let failed = 0;
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const rows = await db
      .select({
        prospectId: prospectActivations.prospectId,
        companyId: prospectActivations.companyId,
        snapshot: prospectActivations.snapshot,
        updatedAt: prospectActivations.updatedAt,
      })
      .from(prospectActivations)
      .where(
        and(
          workspaceId ? eq(prospectActivations.workspaceId, workspaceId) : undefined,
          prospectIds
            ? inArray(prospectActivations.prospectId, prospectIds)
            : sql`(${prospectActivations.snapshot} ->> 'captureSource' = 'linkedin-public-profile' or ${prospectActivations.snapshot} ? 'linkedinPublicId')`
        )
      )
      // workspaceId breaks ties so offset paging stays stable when several workspaces hold the same person.
      .orderBy(prospectActivations.prospectId, prospectActivations.workspaceId)
      .limit(pageSize)
      .offset(offset);
    const docs = rows
      .filter((row) => isLinkedinCapture((row.snapshot ?? {}) as Json))
      .map((row) =>
        capturedPersonDocument(row.prospectId, row.companyId ?? row.prospectId, (row.snapshot ?? {}) as Json, row.updatedAt)
      )
      .filter((doc) => doc.fullName);
    const result = await bulkUpsertProspects(cfg, docs);
    indexed += result.ingested;
    failed += result.failed;
    if (rows.length < pageSize) break;
  }
  return { indexed, failed };
}
