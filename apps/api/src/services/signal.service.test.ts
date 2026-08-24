import { describe, expect, it, vi } from "vitest";
import {
  computeSignalStackScore,
  isSignalExpired,
  listSignalsForEntities,
  listSignalsForEntity,
  overlaySignalsForMember,
  recordSignal,
  signalStackWeightsFromEnv,
} from "./signal.service.js";
import type { SignalRecord } from "./signal.service.js";
import type { Env } from "../config/env.js";

// select chain that terminates at .limit() (mirrors list.service.test.ts's helper).
function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

const ROW = {
  id: "sig-1",
  entityType: "company",
  entityId: "company-hash-1",
  signalType: "recent_hiring",
  value: { detail: "5 open roles" },
  confidence: 0.8,
  detectedAt: new Date("2026-01-01T00:00:00.000Z"),
  source: "linkedin_jobs",
  provenance: { source: "linkedin_jobs" },
  createdAt: new Date("2026-01-01T00:05:00.000Z"),
};

describe("listSignalsForEntity", () => {
  it("returns [] when no rows match", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await listSignalsForEntity(db as never, "company-hash-1");
    expect(result).toEqual([]);
  });

  it("serializes rows with ISO date strings", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([ROW])) };
    const result = await listSignalsForEntity(db as never, "company-hash-1");
    expect(result).toEqual([
      {
        id: "sig-1",
        entityType: "company",
        entityId: "company-hash-1",
        signalType: "recent_hiring",
        value: { detail: "5 open roles" },
        confidence: 0.8,
        observedAt: "2026-01-01T00:00:00.000Z", // falls back to detectedAt — ROW has no observedAt
        detectedAt: "2026-01-01T00:00:00.000Z",
        source: "linkedin_jobs",
        provenance: { source: "linkedin_jobs" },
        createdAt: "2026-01-01T00:05:00.000Z",
        expiresAt: null,
        activationPaths: [],
      },
    ]);
  });

  it("passes signalType/entityType filters and limit through to the query", async () => {
    const chain = selectChain([ROW]);
    const db = { select: vi.fn().mockReturnValue(chain) };
    await listSignalsForEntity(db as never, "company-hash-1", {
      entityType: "company",
      signalType: "recent_hiring",
      limit: 5,
    });
    expect((chain.limit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(5);
  });

  it("defaults the limit to 100 when not provided", async () => {
    const chain = selectChain([]);
    const db = { select: vi.fn().mockReturnValue(chain) };
    await listSignalsForEntity(db as never, "company-hash-1");
    expect((chain.limit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(100);
  });
});

function selectOrderChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockResolvedValue(result);
  return c;
}

describe("listSignalsForEntities", () => {
  it("returns an empty map when no ids are given", async () => {
    const db = { select: vi.fn() };
    const result = await listSignalsForEntities(db as never, []);
    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("groups rows by entityId and keeps newest first", async () => {
    const older = { ...ROW, id: "sig-old", detectedAt: new Date("2025-12-01T00:00:00.000Z") };
    const other = { ...ROW, id: "sig-2", entityId: "company-hash-2", signalType: "recent_funding" };
    const db = { select: vi.fn().mockReturnValue(selectOrderChain([ROW, older, other])) };
    const result = await listSignalsForEntities(db as never, ["company-hash-1", "company-hash-2"]);
    expect(result.get("company-hash-1")?.map((s) => s.id)).toEqual(["sig-1", "sig-old"]);
    expect(result.get("company-hash-2")?.map((s) => s.signalType)).toEqual(["recent_funding"]);
  });
});

describe("overlaySignalsForMember", () => {
  it("merges prospect + company signals and caps at 3 newest", () => {
    const byEntity = new Map([
      [
        "p-1",
        [
          {
            id: "a",
            entityType: "prospect",
            entityId: "p-1",
            signalType: "engagement_decay",
            value: { reason: "no opens" },
            confidence: 0.6,
            observedAt: "2026-03-01T00:00:00.000Z",
            detectedAt: "2026-03-01T00:00:00.000Z",
            source: "risk",
            provenance: {},
            createdAt: "2026-03-01T00:00:00.000Z",
            expiresAt: null,
            activationPaths: [],
          },
        ],
      ],
      [
        "c-1",
        [
          {
            id: "b",
            entityType: "company",
            entityId: "c-1",
            signalType: "recent_funding",
            value: { detail: "Series B" },
            confidence: 0.9,
            observedAt: "2026-04-01T00:00:00.000Z",
            detectedAt: "2026-04-01T00:00:00.000Z",
            source: "crunchbase",
            provenance: {},
            createdAt: "2026-04-01T00:00:00.000Z",
            expiresAt: null,
            activationPaths: [],
          },
          {
            id: "c",
            entityType: "company",
            entityId: "c-1",
            signalType: "tech_adopted",
            value: { tool: "Snowflake" },
            confidence: 0.7,
            observedAt: "2026-02-01T00:00:00.000Z",
            detectedAt: "2026-02-01T00:00:00.000Z",
            source: "builtwith",
            provenance: {},
            createdAt: "2026-02-01T00:00:00.000Z",
            expiresAt: null,
            activationPaths: [],
          },
          {
            id: "d",
            entityType: "company",
            entityId: "c-1",
            signalType: "recent_hiring",
            value: {},
            confidence: null,
            observedAt: "2026-01-15T00:00:00.000Z",
            detectedAt: "2026-01-15T00:00:00.000Z",
            source: null,
            provenance: {},
            createdAt: "2026-01-15T00:00:00.000Z",
            expiresAt: null,
            activationPaths: [],
          },
        ],
      ],
    ]);

    const overlay = overlaySignalsForMember(byEntity, "p-1", "c-1");
    expect(overlay).toEqual([
      { type: "recent_funding", observedAt: "2026-04-01T00:00:00.000Z", detail: "Series B" },
      { type: "engagement_decay", observedAt: "2026-03-01T00:00:00.000Z", detail: "no opens" },
      { type: "tech_adopted", observedAt: "2026-02-01T00:00:00.000Z", detail: "Snowflake" },
    ]);
  });

  it("returns [] when neither entity has signals", () => {
    expect(overlaySignalsForMember(new Map(), "p-1", "c-1")).toEqual([]);
  });
});

describe("computeSignalStackScore", () => {
  const NOW = new Date("2026-04-01T00:00:00.000Z");

  function signal(overrides: Partial<SignalRecord>): SignalRecord {
    return {
      id: "sig",
      entityType: "company",
      entityId: "c-1",
      signalType: "recent_hiring",
      value: {},
      confidence: 0.8,
      observedAt: NOW.toISOString(),
      detectedAt: NOW.toISOString(),
      source: "test",
      provenance: {},
      createdAt: NOW.toISOString(),
      expiresAt: null,
      activationPaths: [],
      ...overrides,
    };
  }

  it("scores 0 / band 'none' with no signals", () => {
    const result = computeSignalStackScore([], { now: NOW });
    expect(result).toMatchObject({ score: 0, band: "none", distinctSignalTypes: 0 });
  });

  it("scores 0 when every signal is a risk/decay type, not a timing signal", () => {
    const result = computeSignalStackScore(
      [signal({ signalType: "engagement_decay" }), signal({ id: "sig-2", signalType: "budget_freeze" })],
      { now: NOW }
    );
    expect(result.score).toBe(0);
    expect(result.contributingSignals).toEqual([]);
  });

  it("multiple corroborating signal types score higher than one weak trigger", () => {
    const one = computeSignalStackScore([signal({ signalType: "recent_hiring" })], { now: NOW });
    const stacked = computeSignalStackScore(
      [
        signal({ id: "a", signalType: "recent_hiring" }),
        signal({ id: "b", signalType: "recent_funding" }),
        signal({ id: "c", signalType: "tech_adopted" }),
      ],
      { now: NOW }
    );
    expect(stacked.distinctSignalTypes).toBe(3);
    expect(stacked.score).toBeGreaterThan(one.score);
  });

  it("a reachable decision-maker scores higher than the same signals without one", () => {
    const signals = [signal({ signalType: "recent_hiring" }), signal({ id: "b", signalType: "recent_funding" })];
    const withoutDm = computeSignalStackScore(signals, { now: NOW, reachableDecisionMaker: false });
    const withDm = computeSignalStackScore(signals, { now: NOW, reachableDecisionMaker: true });
    expect(withDm.score).toBeGreaterThan(withoutDm.score);
    expect(withDm.reachableDecisionMaker).toBe(true);
  });

  it("older signals contribute less than a fresh signal of the same confidence", () => {
    const fresh = computeSignalStackScore([signal({ observedAt: NOW.toISOString() })], { now: NOW });
    const stale = computeSignalStackScore(
      [signal({ observedAt: "2026-01-01T00:00:00.000Z" })],
      { now: NOW }
    );
    expect(stale.score).toBeLessThan(fresh.score);
  });

  it("recency tracks the real-world event time (observedAt), not when we detected it", () => {
    // Detected today, but the underlying event happened two months ago — should score like a stale signal.
    const lateDetected = computeSignalStackScore(
      [signal({ observedAt: "2026-01-01T00:00:00.000Z", detectedAt: NOW.toISOString() })],
      { now: NOW }
    );
    const fresh = computeSignalStackScore([signal({ observedAt: NOW.toISOString() })], { now: NOW });
    expect(lateDetected.score).toBeLessThan(fresh.score);
  });

  it("excludes expired signals from the score entirely", () => {
    const expired = computeSignalStackScore(
      [signal({ expiresAt: "2026-03-01T00:00:00.000Z" })], // expired before NOW (2026-04-01)
      { now: NOW }
    );
    expect(expired).toMatchObject({ score: 0, band: "none", distinctSignalTypes: 0 });
  });

  it("still counts a signal whose expiry is in the future", () => {
    const notYetExpired = computeSignalStackScore(
      [signal({ expiresAt: "2026-05-01T00:00:00.000Z" })],
      { now: NOW }
    );
    expect(notYetExpired.score).toBeGreaterThan(0);
  });

  it("repeating the same signal type stacks quantity but not the diversity multiplier", () => {
    const sameType = computeSignalStackScore(
      [signal({ id: "a", signalType: "recent_hiring" }), signal({ id: "b", signalType: "recent_hiring" })],
      { now: NOW }
    );
    expect(sameType.distinctSignalTypes).toBe(1);
  });

  it("caps the score at 100", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      signal({ id: `s${i}`, signalType: i % 2 === 0 ? "recent_hiring" : "recent_funding", confidence: 1 })
    );
    const result = computeSignalStackScore(many, { now: NOW, reachableDecisionMaker: true });
    expect(result.score).toBe(100);
    expect(result.band).toBe("hot");
  });

  it("uses a default confidence for signals that didn't record one", () => {
    const result = computeSignalStackScore([signal({ confidence: null })], { now: NOW });
    expect(result.contributingSignals[0]?.confidence).toBeGreaterThan(0);
  });
});

describe("signalStackWeightsFromEnv", () => {
  it("maps every SIGNAL_STACK_* env var into the weights object actually used by scoring", () => {
    const config = {
      SIGNAL_STACK_DEFAULT_CONFIDENCE: 0.5,
      SIGNAL_STACK_RECENCY_HALF_LIFE_DAYS: 7,
      SIGNAL_STACK_RECENCY_FLOOR: 0.1,
      SIGNAL_STACK_MULTIPLIER_2_TYPES: 2,
      SIGNAL_STACK_MULTIPLIER_3_TYPES: 3,
      SIGNAL_STACK_DECISION_MAKER_MULTIPLIER: 1.5,
      SIGNAL_STACK_SCORE_SCALE: 50,
    } as Env;

    expect(signalStackWeightsFromEnv(config)).toEqual({
      defaultConfidence: 0.5,
      recencyHalfLifeDays: 7,
      recencyFloor: 0.1,
      multiplierByDistinctTypes: { 1: 1, 2: 2, 3: 3 },
      decisionMakerMultiplier: 1.5,
      scoreScale: 50,
    });
  });

  it("a custom env-derived weight actually changes the computed score", () => {
    const signal: SignalRecord = {
      id: "s1",
      entityType: "company",
      entityId: "c-1",
      signalType: "recent_hiring",
      value: {},
      confidence: 0.8,
      observedAt: "2026-04-01T00:00:00.000Z",
      detectedAt: "2026-04-01T00:00:00.000Z",
      source: "test",
      provenance: {},
      createdAt: "2026-04-01T00:00:00.000Z",
      expiresAt: null,
      activationPaths: [],
    };
    const now = new Date("2026-04-01T00:00:00.000Z");
    const baseConfig = {
      SIGNAL_STACK_DEFAULT_CONFIDENCE: 0.6,
      SIGNAL_STACK_RECENCY_HALF_LIFE_DAYS: 14,
      SIGNAL_STACK_RECENCY_FLOOR: 0.05,
      SIGNAL_STACK_MULTIPLIER_2_TYPES: 1.3,
      SIGNAL_STACK_MULTIPLIER_3_TYPES: 1.6,
      SIGNAL_STACK_DECISION_MAKER_MULTIPLIER: 1.25,
    };
    const lowScale = signalStackWeightsFromEnv({ ...baseConfig, SIGNAL_STACK_SCORE_SCALE: 10 } as Env);
    const highScale = signalStackWeightsFromEnv({ ...baseConfig, SIGNAL_STACK_SCORE_SCALE: 90 } as Env);

    const low = computeSignalStackScore([signal], { now, weights: lowScale });
    const high = computeSignalStackScore([signal], { now, weights: highScale });
    expect(high.score).toBeGreaterThan(low.score);
  });
});

describe("isSignalExpired", () => {
  const now = new Date("2026-04-01T00:00:00.000Z");

  it("is false when expiresAt is null", () => {
    expect(isSignalExpired({ expiresAt: null }, now)).toBe(false);
  });

  it("is false when expiresAt is in the future", () => {
    expect(isSignalExpired({ expiresAt: "2026-05-01T00:00:00.000Z" }, now)).toBe(false);
  });

  it("is true when expiresAt is in the past", () => {
    expect(isSignalExpired({ expiresAt: "2026-03-01T00:00:00.000Z" }, now)).toBe(true);
  });

  it("is true at the exact expiry instant", () => {
    expect(isSignalExpired({ expiresAt: now.toISOString() }, now)).toBe(true);
  });
});

describe("recordSignal", () => {
  it("persists expiresAt and activationPaths, defaulting activationPaths to []", async () => {
    const inserted: Record<string, unknown>[] = [];
    const row = {
      id: "sig-new",
      entityType: "prospect",
      entityId: "p-1",
      signalType: "recent_hiring",
      value: {},
      confidence: null,
      detectedAt: new Date("2026-04-01T00:00:00.000Z"),
      source: "manual",
      provenance: {},
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
      activationPaths: ["add_to_list"],
    };
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: vi.fn().mockResolvedValue([row]) };
        }),
      })),
    };

    const result = await recordSignal(db as never, {
      entityId: "p-1",
      signalType: "recent_hiring",
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
      activationPaths: ["add_to_list"],
    });

    expect(inserted[0]).toMatchObject({
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
      activationPaths: ["add_to_list"],
    });
    expect(result.expiresAt).toBe("2026-05-01T00:00:00.000Z");
    expect(result.activationPaths).toEqual(["add_to_list"]);
  });

  it("defaults expiresAt to null and activationPaths to [] when omitted", async () => {
    const inserted: Record<string, unknown>[] = [];
    const row = {
      id: "sig-new",
      entityType: "prospect",
      entityId: "p-1",
      signalType: "recent_hiring",
      value: {},
      confidence: null,
      detectedAt: new Date("2026-04-01T00:00:00.000Z"),
      source: null,
      provenance: {},
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      expiresAt: null,
      activationPaths: [],
    };
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: vi.fn().mockResolvedValue([row]) };
        }),
      })),
    };

    await recordSignal(db as never, { entityId: "p-1", signalType: "recent_hiring" });

    expect(inserted[0]).toMatchObject({ expiresAt: null, activationPaths: [] });
  });
});
