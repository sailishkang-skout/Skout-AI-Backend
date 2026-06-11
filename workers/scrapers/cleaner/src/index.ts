import {
  prospectCandidateSchema,
  toEmployeeBucket,
  type ProspectCandidate,
} from "@skout/scraper-contracts";

/**
 * Cleaner pipeline (E1.4 scaffold): parse → validate → normalize → dedupe →
 * quality-score. Each stage is a pure function; rows that fail validation or
 * fall below the quality threshold are quarantined.
 */

const QUALITY_THRESHOLD = 40;

export interface CleanResult {
  clean: ProspectCandidate[];
  quarantined: { record: unknown; reason: string }[];
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

export function qualityScore(c: ProspectCandidate): number {
  let score = 0;
  if (c.email) score += 40;
  if (c.fullName) score += 20;
  if (c.title) score += 15;
  if (c.companyDomain) score += 15;
  if (c.linkedinUrl) score += 10;
  return Math.min(100, score);
}

/** Run the cleaning pipeline over raw parsed candidate objects. */
export function cleanProspects(records: unknown[]): CleanResult {
  const clean: ProspectCandidate[] = [];
  const quarantined: { record: unknown; reason: string }[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const parsed = prospectCandidateSchema.safeParse(record);
    if (!parsed.success) {
      quarantined.push({ record, reason: parsed.error.issues.map((i) => i.message).join("; ") });
      continue;
    }
    const candidate: ProspectCandidate = {
      ...parsed.data,
      companyDomain: normalizeDomain(parsed.data.companyDomain),
      country: parsed.data.country?.toUpperCase(),
    };
    const score = qualityScore(candidate);
    candidate.qualityScore = score;
    if (score < QUALITY_THRESHOLD) {
      quarantined.push({ record, reason: `quality ${score} < ${QUALITY_THRESHOLD}` });
      continue;
    }
    const dedupeKey = `${candidate.companyDomain}|${candidate.email ?? candidate.fullName ?? ""}`;
    if (seen.has(dedupeKey)) {
      quarantined.push({ record, reason: "duplicate" });
      continue;
    }
    seen.add(dedupeKey);
    clean.push(candidate);
  }

  return { clean, quarantined };
}

export { toEmployeeBucket };
