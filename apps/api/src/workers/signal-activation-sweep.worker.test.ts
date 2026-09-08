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
});
