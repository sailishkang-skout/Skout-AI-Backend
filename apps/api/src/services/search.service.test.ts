import { describe, expect, it, vi } from "vitest";
import { SearchService } from "./search.service.js";
import { computeSignalStackScore, signalStackWeightsFromEnv } from "./signal.service.js";

// §8.2 SS-04 — fit/timing traceability: fitScore must equal the doc's own ICP/firmographic
// match field, and timingScore must be a real computeSignalStackScore() result (not a synthetic
// split of some prior composite, and not silently undefined just because a request went through
// getProspectById/findExistingProspect instead of the list-search path).

// Matches signal.service.test.ts's chain convention: listSignalsForEntities terminates at
// .orderBy(), not .limit().
function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockResolvedValue(result);
  return c;
}

// No OPENSEARCH_URL -> osConfig() returns null -> service falls back to the deterministic demo
// corpus, so these tests need no network/OpenSearch mock at all.
const ENV = {
  DEMO_CORPUS_SIZE: 10,
  SIGNAL_STACK_DEFAULT_CONFIDENCE: 0.6,
  SIGNAL_STACK_RECENCY_HALF_LIFE_DAYS: 14,
  SIGNAL_STACK_RECENCY_FLOOR: 0.05,
  SIGNAL_STACK_MULTIPLIER_2_TYPES: 1.3,
  SIGNAL_STACK_MULTIPLIER_3_TYPES: 1.6,
  SIGNAL_STACK_DECISION_MAKER_MULTIPLIER: 1.25,
  SIGNAL_STACK_SCORE_SCALE: 35,
} as never;

// Shape of a raw `signals` table row, as `listSignalsForEntities`'s serialize() expects
// (Date fields) — entityId filled in per-test with the demo doc's real prospectId.
function signalDbRow(entityId: string) {
  return {
    id: "sig-1",
    entityType: "prospect",
    entityId,
    signalType: "recent_hiring",
    value: {},
    confidence: 0.8,
    strength: null,
    evidenceId: null,
    observedAt: new Date("2026-01-01T00:00:00.000Z"),
    detectedAt: new Date("2026-01-01T00:00:00.000Z"),
    source: "linkedin_jobs",
    provenance: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
    activationPaths: [],
  };
}

describe("SearchService — fit/timing score traceability", () => {
  it("getProspectById reports fitScore from the doc's own ICP field and a real timingScore, not undefined", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) }; // no signals -> a real, defined "none" band, not a gap
    const service = new SearchService(ENV, db as never);

    // Grab a real demo doc id via a search, rather than reconstructing the corpus's hash logic.
    const searchResult = await service.searchProspects({ page: 1, pageSize: 1 } as never);
    const knownDoc = searchResult.results[0]!;

    const detail = await service.getProspectById(knownDoc.prospectId);

    expect(detail).not.toBeNull();
    expect(detail!.fitScore).toBe(knownDoc.fitScore); // same underlying ICP field, not a guess
    expect(typeof detail!.timingScore).toBe("number"); // previously undefined on this code path
  });

  it("timingScore reflects real recorded signals for that prospect (not a synthetic split)", async () => {
    const service = new SearchService(ENV, { select: vi.fn().mockReturnValue(selectChain([])) } as never);
    const searchResult = await service.searchProspects({ page: 1, pageSize: 1 } as never);
    const knownDoc = searchResult.results[0]!;

    const dbRow = signalDbRow(knownDoc.prospectId);
    const dbWithSignal = { select: vi.fn().mockReturnValue(selectChain([dbRow])) };
    const serviceWithSignal = new SearchService(ENV, dbWithSignal as never);

    const detail = await serviceWithSignal.getProspectById(knownDoc.prospectId);

    const expectedSignal = {
      id: dbRow.id,
      entityType: dbRow.entityType,
      entityId: dbRow.entityId,
      signalType: dbRow.signalType,
      value: dbRow.value,
      confidence: dbRow.confidence,
      strength: dbRow.strength,
      evidenceId: dbRow.evidenceId,
      observedAt: dbRow.observedAt.toISOString(),
      detectedAt: dbRow.detectedAt.toISOString(),
      source: dbRow.source,
      provenance: dbRow.provenance,
      createdAt: dbRow.createdAt.toISOString(),
      expiresAt: null,
      activationPaths: [],
    };
    const DECISION_MAKER_SENIORITIES = new Set(["founder", "co_founder", "ceo", "c_level", "vp", "director", "head"]);
    const reachableDecisionMaker = Boolean(
      knownDoc.seniority && DECISION_MAKER_SENIORITIES.has(knownDoc.seniority.toLowerCase())
    );
    const expected = computeSignalStackScore([expectedSignal], {
      weights: signalStackWeightsFromEnv(ENV),
      reachableDecisionMaker,
    });
    expect(detail!.timingScore).toBe(expected.score);
    expect(detail!.timingScore).toBeGreaterThan(0);
  });

  it("findExistingProspect (used by prospect-resolver) also populates timingScore, matching getProspectById", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const service = new SearchService(ENV, db as never);
    const searchResult = await service.searchProspects({ page: 1, pageSize: 1 } as never);
    const knownDoc = searchResult.results[0]!;

    const found = await service.findExistingProspect(knownDoc.prospectId);

    expect(found).not.toBeNull();
    expect(typeof found!.timingScore).toBe("number");
  });

  it("searchProspects list results already carry both fields distinctly (regression guard)", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const service = new SearchService(ENV, db as never);

    const result = await service.searchProspects({ page: 1, pageSize: 3 } as never);

    for (const hit of result.results) {
      expect(hit).toHaveProperty("fitScore");
      expect(hit).toHaveProperty("timingScore");
      expect(typeof hit.timingScore).toBe("number");
    }
  });
});
