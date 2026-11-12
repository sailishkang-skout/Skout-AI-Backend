// LinkedIn profile captures in Search & Discover. Each captured person is indexed into the
// prospect search index as a workspace-private document, so only the workspace that captured
// them finds them, by name, headline, company, role, past company, school, skill or location.
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

/** Index document ID: a person captured by two workspaces gets one private copy each. */
export function capturedDocId(workspaceId: string, prospectId: string): string {
  return `capture:${workspaceId}:${prospectId}`;
}

/** True when a prospect snapshot came from a LinkedIn profile capture. */
export function isLinkedinCapture(snapshot: Json): boolean {
  return snapshot.captureSource === "linkedin-public-profile" || !!str(snapshot.linkedinPublicId);
}

/** Search document for one captured person, built from the saved prospect snapshot. */
export function capturedPersonDocument(
  workspaceId: string,
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
    workspaceId,
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
 * Indexes captured people of one workspace: the given prospects, or every captured profile
 * when `prospectIds` is omitted (backfill). Returns how many documents were written.
 */
export async function indexCapturedPeople(
  db: Db,
  cfg: OpenSearchConfig,
  workspaceId: string,
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
          eq(prospectActivations.workspaceId, workspaceId),
          prospectIds
            ? inArray(prospectActivations.prospectId, prospectIds)
            : sql`(${prospectActivations.snapshot} ->> 'captureSource' = 'linkedin-public-profile' or ${prospectActivations.snapshot} ? 'linkedinPublicId')`
        )
      )
      .orderBy(prospectActivations.prospectId)
      .limit(pageSize)
      .offset(offset);
    const docs = rows
      .filter((row) => isLinkedinCapture((row.snapshot ?? {}) as Json))
      .map((row) =>
        capturedPersonDocument(workspaceId, row.prospectId, row.companyId ?? row.prospectId, (row.snapshot ?? {}) as Json, row.updatedAt)
      )
      .filter((doc) => doc.fullName);
    const result = await bulkUpsertProspects(cfg, docs, (doc) => capturedDocId(workspaceId, doc.prospectId));
    indexed += result.ingested;
    failed += result.failed;
    if (rows.length < pageSize) break;
  }
  return { indexed, failed };
}
