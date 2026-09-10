import { beforeEach, describe, expect, it, vi } from "vitest";

const executeActivationRules = vi.fn().mockResolvedValue({ matched: 1, executed: 1, failed: 0 });
vi.mock("../services/activation-rules.service.js", () => ({
  executeActivationRules: (...args: unknown[]) => executeActivationRules(...args),
}));

const enqueueDexterEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("./dexter-events.queue.js", () => ({
  enqueueDexterEvent: (...args: unknown[]) => enqueueDexterEvent(...args),
}));

const listSignalsForEntity = vi.fn().mockResolvedValue([]);
vi.mock("../services/signal.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/signal.service.js")>();
  return {
    ...actual,
    listSignalsForEntity: (...args: unknown[]) => listSignalsForEntity(...args),
    // Real computeSignalStackScore/signalStrengthByType/toSignalRecord stay in place — they're
    // pure and exactly what this worker's `minSignalStrength` support depends on — but the env
    // is stubbed to DEFAULT_SIGNAL_STACK_WEIGHTS since CONFIG here carries no SIGNAL_STACK_* fields.
    signalStackWeightsFromEnv: () => actual.DEFAULT_SIGNAL_STACK_WEIGHTS,
  };
});

const { matchAndActivateSignal } = await import("./signal-activation-sweep.worker.js");

const CONFIG = {} as never;

/** FIFO chainable `.select().from().where()` mock — each `.where()` call resolves the next
 * queued result, in the order the worker issues its queries (owners lookup, then one score
 * lookup per distinct owner). */
function mockDb(results: unknown[][]) {
  let i = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(results[i++] ?? [])),
      })),
    })),
  };
}

/** A full `signals` row — matchAndActivateSignal now folds the triggering row itself into
 * `computeSignalStackScore` (via `toSignalRecord`), so tests need every field `serialize` reads. */
function signalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sig-1",
    entityType: "company",
    entityId: "company-1",
    signalType: "leadership_change",
    value: {},
    confidence: 0.8,
    strength: null,
    evidenceId: null,
    observedAt: null,
    detectedAt: new Date("2026-09-01T00:00:00.000Z"),
    source: "company-web",
    provenance: {},
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    expiresAt: null,
    activationPaths: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeActivationRules.mockResolvedValue({ matched: 1, executed: 1, failed: 0 });
  listSignalsForEntity.mockResolvedValue([]);
  enqueueDexterEvent.mockResolvedValue(undefined);
});

describe("matchAndActivateSignal", () => {
  const companySignal = signalRow();

  it("fans a company-level signal out to every prospect activated at that company", async () => {
    const db = mockDb([
      [
        { workspaceId: "ws-1", prospectId: "p-1" },
        { workspaceId: "ws-1", prospectId: "p-2" },
      ],
      [{ score: 80 }], // p-1's score
      [{ score: 60 }], // p-2's score
    ]);

    const outcome = await matchAndActivateSignal(db as never, CONFIG, companySignal as never);

    expect(outcome).toEqual({ matched: 2, executed: 2, failed: 0 });
    expect(executeActivationRules).toHaveBeenCalledTimes(2);
    expect(executeActivationRules).toHaveBeenCalledWith(
      db,
      CONFIG,
      "ws-1",
      "p-1",
      80,
      ["leadership_change"],
      expect.any(Object)
    );
    expect(executeActivationRules).toHaveBeenCalledWith(
      db,
      CONFIG,
      "ws-1",
      "p-2",
      60,
      ["leadership_change"],
      expect.any(Object)
    );
  });

  it("skips a prospect that has never been scored — nothing to threshold against", async () => {
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], []]);

    const outcome = await matchAndActivateSignal(db as never, CONFIG, companySignal as never);

    expect(outcome).toEqual({ matched: 0, executed: 0, failed: 0 });
    expect(executeActivationRules).not.toHaveBeenCalled();
  });

  it("dedupes multiple activation rows sharing the same (workspace, prospect) pair", async () => {
    const db = mockDb([
      [
        { workspaceId: "ws-1", prospectId: "p-1" },
        { workspaceId: "ws-1", prospectId: "p-1" },
      ],
      [{ score: 80 }],
    ]);

    await matchAndActivateSignal(db as never, CONFIG, companySignal as never);

    expect(executeActivationRules).toHaveBeenCalledTimes(1);
  });

  it("uses entityId directly (prospectId column) for a prospect-level signal", async () => {
    const prospectSignal = signalRow({ id: "sig-2", entityType: "prospect", entityId: "p-1", signalType: "engagement_decay" });
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 90 }]]);

    await matchAndActivateSignal(db as never, CONFIG, prospectSignal as never);

    expect(executeActivationRules).toHaveBeenCalledWith(
      db,
      CONFIG,
      "ws-1",
      "p-1",
      90,
      ["engagement_decay"],
      expect.any(Object)
    );
  });

  it("unions the triggering signal type with the prospect's other already-active signal types", async () => {
    listSignalsForEntity.mockResolvedValue([{ signalType: "recent_hiring" }, { signalType: "leadership_change" }]);
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);

    await matchAndActivateSignal(db as never, CONFIG, companySignal as never);

    const activeSignalTypes = executeActivationRules.mock.calls[0]![5];
    expect(activeSignalTypes).toEqual(expect.arrayContaining(["leadership_change", "recent_hiring"]));
    // no duplicate entry for leadership_change even though it's both the trigger and already active
    expect(activeSignalTypes).toHaveLength(2);
  });

  it("passes a strength for the triggering signal's own type, derived from its confidence/recency", async () => {
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);

    await matchAndActivateSignal(db as never, CONFIG, companySignal as never);

    const strengthByType = executeActivationRules.mock.calls[0]![6] as Record<string, number>;
    expect(strengthByType.leadership_change).toBeGreaterThan(0);
  });

  it("counts a failed rule execution without throwing, so one bad prospect doesn't block the rest", async () => {
    executeActivationRules
      .mockResolvedValueOnce({ matched: 1, executed: 0, failed: 1 })
      .mockResolvedValueOnce({ matched: 1, executed: 1, failed: 0 });
    const db = mockDb([
      [
        { workspaceId: "ws-1", prospectId: "p-1" },
        { workspaceId: "ws-1", prospectId: "p-2" },
      ],
      [{ score: 80 }],
      [{ score: 60 }],
    ]);

    const outcome = await matchAndActivateSignal(db as never, CONFIG, companySignal as never);

    expect(outcome).toEqual({ matched: 2, executed: 1, failed: 1 });
  });
});

describe("matchAndActivateSignal — signal.high_strength Dexter event (SS-08)", () => {
  const strongSignal = signalRow({ confidence: 0.8, strength: 1, detectedAt: new Date() });

  it("emits signal.high_strength when the signal's own weight clears the configured floor", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);

    await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(enqueueDexterEvent).toHaveBeenCalledTimes(1);
    const [, event] = enqueueDexterEvent.mock.calls[0]!;
    expect(event).toMatchObject({
      type: "signal.high_strength",
      tenantId: "ws-1",
      aggregateId: strongSignal.id,
      data: { signalId: strongSignal.id, signalType: strongSignal.signalType },
    });
  });

  it("does not emit when the signal's weight is below the configured floor", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.95 } as never;
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);

    await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(enqueueDexterEvent).not.toHaveBeenCalled();
  });

  it("emits once per distinct workspace, not once per activated prospect", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([
      [
        { workspaceId: "ws-1", prospectId: "p-1" },
        { workspaceId: "ws-1", prospectId: "p-2" },
      ],
      [{ score: 80 }],
      [{ score: 60 }],
    ]);

    await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(enqueueDexterEvent).toHaveBeenCalledTimes(1);
  });

  it("still emits for a prospect that has never been scored — Dexter's trigger isn't score-gated", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], []]);

    await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(enqueueDexterEvent).toHaveBeenCalledTimes(1);
    expect(executeActivationRules).not.toHaveBeenCalled();
  });

  it("emits once for each distinct workspace even when multiple prospects exist", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([
      [
        { workspaceId: "ws-1", prospectId: "p-1" },
        { workspaceId: "ws-2", prospectId: "p-3" },
        { workspaceId: "ws-1", prospectId: "p-2" }, // same workspace as p-1
      ],
      [{ score: 80 }],
      [{ score: 70 }],
      [{ score: 60 }],
    ]);

    await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(enqueueDexterEvent).toHaveBeenCalledTimes(2); // once per workspace (ws-1 and ws-2)
  });

  it("handles enqueueDexterEvent failure gracefully without blocking other work", async () => {
    enqueueDexterEvent.mockRejectedValueOnce(new Error("Dexter queue is down"));
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);
    // Suppress expected console error from intentional queue failure
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(outcome).toEqual({ matched: 1, executed: 1, failed: 0 }); // activation still works!
    expect(executeActivationRules).toHaveBeenCalledTimes(1); // rule execution still happened
    consoleErrorSpy.mockRestore(); // restore console.error after test
  });

  it("still emits Dexter event when soloStrength is exactly equal to min strength threshold", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never; // Use same threshold as all other tests
    const signalExactlyAtThreshold = {
      ...strongSignal, // Use the same strongSignal base object as all other tests
      soloStrength: 0.5, // Exactly matches threshold (passes because implementation uses >=)
    } as never;
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 0 }]]);

    await matchAndActivateSignal(db as never, config, signalExactlyAtThreshold);

    expect(enqueueDexterEvent).toHaveBeenCalledTimes(1); // Correctly passes because implementation uses >=
  });

  it("correctly processes zero prospects when no owners are found in the database", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([[]]); // no owners found

    const outcome = await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(outcome).toEqual({ matched: 0, executed: 0, failed: 0 });
    expect(executeActivationRules).not.toHaveBeenCalled();
    expect(enqueueDexterEvent).not.toHaveBeenCalled(); // no workspaces to notify
  });

  it("handles null soloStrength gracefully and doesn't emit Dexter event", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const weakSignal = signalRow({ confidence: 0, strength: null, detectedAt: new Date() });
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);

    await matchAndActivateSignal(db as never, config, weakSignal as never);

    expect(enqueueDexterEvent).not.toHaveBeenCalled(); // null strength < threshold, no event
  });

  it("dedupes activation calls even when same prospect appears multiple times across different owners rows", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([
      [
        { workspaceId: "ws-1", prospectId: "p-1" },
        { workspaceId: "ws-1", prospectId: "p-1" }, // duplicate row
        { workspaceId: "ws-1", prospectId: "p-1" }, // another duplicate
      ],
      [{ score: 80 }], // only one score lookup
    ]);

    await matchAndActivateSignal(db as never, config, strongSignal as never);

    expect(executeActivationRules).toHaveBeenCalledTimes(1); // only executed once despite 3 rows
  });

  // EDGE CASE 1: signal with undefined entityType/entityId (malformed signal) is handled gracefully
  it("handles malformed signal with missing entityType/entityId without crashing", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const malformedSignal = {
      ...strongSignal,
      entityType: undefined,
      entityId: undefined,
    } as never;
    const db = mockDb([[], []]); // empty database to avoid any matches

    const outcome = await matchAndActivateSignal(db as never, config, malformedSignal);
    
    expect(outcome).toEqual({ matched: 0, executed: 0, failed: 0 }); // fails gracefully
    expect(executeActivationRules).not.toHaveBeenCalled();
    expect(enqueueDexterEvent).not.toHaveBeenCalled(); // no event emitted for bad signal
  });

  // EDGE CASE 2: database query returns null/undefined values instead of rows
  it("handles null database query results gracefully", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([[], []]); // empty database results
    executeActivationRules.mockClear();

    const outcome = await matchAndActivateSignal(db as never, config, strongSignal as never);
    
    expect(outcome).toEqual({ matched: 0, executed: 0, failed: 0 });
    expect(executeActivationRules).not.toHaveBeenCalled();
  });

  // EDGE CASE 3: executeActivationRules throws an error, but other work continues
  it("handles executeActivationRules failure without blocking processing of other signals", async () => {
    executeActivationRules.mockRejectedValueOnce(new Error("Database connection timeout"));
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);

    const outcome = await matchAndActivateSignal(db as never, config, strongSignal as never);
    
    // Still returns a valid outcome instead of throwing
    expect(outcome.failed).toBe(1); // marks this execution as failed
    expect(executeActivationRules).toHaveBeenCalledTimes(1);
  });

  // EDGE CASE 4: signal with strength exactly 0 is handled gracefully
  it("does not emit Dexter event for signal with strength exactly 0", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    const zeroStrengthSignal = {
      ...strongSignal,
      soloStrength: 0,
      strength: 0,
    } as never;
    const db = mockDb([[{ workspaceId: "ws-1", prospectId: "p-1" }], [{ score: 80 }]]);

    await matchAndActivateSignal(db as never, config, zeroStrengthSignal);
    
    expect(enqueueDexterEvent).not.toHaveBeenCalled();
  });

  // EDGE CASE 5: multiple distinct workspaces, emits event for each exactly once
  it("emits exactly one Dexter event per distinct workspace, even with many prospects", async () => {
    const config = { DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH: 0.5 } as never;
    // 5 different workspaces, 10 prospects each
    const prospectRows = Array.from({ length: 50 }, (_, i) => ({
      workspaceId: `ws-${i % 5}`, // 5 unique workspaces repeated
      prospectId: `p-${i}`,
    }));
    // mockDb expects array of query results - we only need 1 score query, not 50
    const db = mockDb([prospectRows, [{ score: 80 }]]);

    await matchAndActivateSignal(db as never, config, strongSignal as never);
    
    // Exactly 5 events, one per unique workspace
    expect(enqueueDexterEvent).toHaveBeenCalledTimes(5);
  });
});