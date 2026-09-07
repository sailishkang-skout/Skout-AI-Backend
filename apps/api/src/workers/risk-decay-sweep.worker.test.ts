import { describe, expect, it, vi, beforeEach } from "vitest";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";

const recordSignal = vi.fn();
vi.mock("../services/signal.service.js", () => ({
  recordSignal: (...args: unknown[]) => recordSignal(...args),
}));

const emitSkoutEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../services/skout-event.service.js", () => ({
  emitSkoutEvent: (...args: unknown[]) => emitSkoutEvent(...args),
}));

const { sweepWorkspaceForDecay } = await import("./risk-decay-sweep.worker.js");

const WORKSPACE = "ws-1";
const config = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

function makeFakeDb(opts: {
  activations: { prospectId: string; activatedAt: Date }[];
  stepEvents?: { at: Date }[];
  messageEvents?: { at: Date }[];
  recentDecaySignal?: { detectedAt: Date } | null;
}) {
  const { activations, stepEvents = [], messageEvents = [], recentDecaySignal = null } = opts;

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === schema.prospectActivations) {
          return { where: vi.fn(() => Promise.resolve(activations)) };
        }
        if (table === schema.sequenceEnrollmentSteps) {
          return { innerJoin: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(stepEvents)) })) };
        }
        if (table === schema.inboxMessages) {
          return { innerJoin: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(messageEvents)) })) };
        }
        if (table === schema.signals) {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve(recentDecaySignal ? [recentDecaySignal] : [])),
              })),
            })),
          };
        }
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
  };
  return db as never;
}

const LONG_INACTIVE = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

describe("sweepWorkspaceForDecay", () => {
  it("flags a decayed prospect, records an engagement_decay signal, and emits signal.detected when config is provided", async () => {
    recordSignal.mockResolvedValue({ id: "sig-1", entityType: "prospect", entityId: "p-1", signalType: "engagement_decay" });
    const db = makeFakeDb({ activations: [{ prospectId: "p-1", activatedAt: LONG_INACTIVE }] });

    const flagged = await sweepWorkspaceForDecay(db, WORKSPACE, 90, config);

    expect(flagged).toBe(1);
    expect(recordSignal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ entityType: "prospect", entityId: "p-1", signalType: "engagement_decay" })
    );
    expect(emitSkoutEvent).toHaveBeenCalledWith(
      db,
      config,
      expect.objectContaining({
        type: "signal.detected",
        tenantId: WORKSPACE,
        aggregateId: "p-1",
        data: expect.objectContaining({ signalId: "sig-1", signalType: "engagement_decay" }),
      })
    );
  });

  it("does not emit signal.detected when no config is passed (event spine unavailable)", async () => {
    recordSignal.mockResolvedValue({ id: "sig-1", entityType: "prospect", entityId: "p-1", signalType: "engagement_decay" });
    const db = makeFakeDb({ activations: [{ prospectId: "p-1", activatedAt: LONG_INACTIVE }] });

    const flagged = await sweepWorkspaceForDecay(db, WORKSPACE, 90);

    expect(flagged).toBe(1);
    expect(recordSignal).toHaveBeenCalled();
    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });

  it("skips a prospect activated too recently to judge as decayed", async () => {
    const db = makeFakeDb({ activations: [{ prospectId: "p-1", activatedAt: new Date() }] });

    const flagged = await sweepWorkspaceForDecay(db, WORKSPACE, 90, config);

    expect(flagged).toBe(0);
    expect(recordSignal).not.toHaveBeenCalled();
    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });

  it("skips a prospect with recent activity — not actually decayed", async () => {
    const db = makeFakeDb({
      activations: [{ prospectId: "p-1", activatedAt: LONG_INACTIVE }],
      stepEvents: [{ at: new Date() }],
    });

    const flagged = await sweepWorkspaceForDecay(db, WORKSPACE, 90, config);

    expect(flagged).toBe(0);
    expect(recordSignal).not.toHaveBeenCalled();
  });

  it("does not re-flag when an engagement_decay signal was already recorded inside the current inactivity window", async () => {
    const db = makeFakeDb({
      activations: [{ prospectId: "p-1", activatedAt: LONG_INACTIVE }],
      recentDecaySignal: { detectedAt: new Date() },
    });

    const flagged = await sweepWorkspaceForDecay(db, WORKSPACE, 90, config);

    expect(flagged).toBe(0);
    expect(recordSignal).not.toHaveBeenCalled();
    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });

  it("does not throw when emitSkoutEvent rejects", async () => {
    recordSignal.mockResolvedValue({ id: "sig-1", entityType: "prospect", entityId: "p-1", signalType: "engagement_decay" });
    emitSkoutEvent.mockRejectedValueOnce(new Error("queue unavailable"));
    const db = makeFakeDb({ activations: [{ prospectId: "p-1", activatedAt: LONG_INACTIVE }] });

    const flagged = await sweepWorkspaceForDecay(db, WORKSPACE, 90, config);

    expect(flagged).toBe(1);
  });
});
