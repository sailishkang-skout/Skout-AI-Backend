import { beforeEach, describe, expect, it, vi } from "vitest";

const createNotification = vi.fn().mockResolvedValue({ id: "notif-1" });
vi.mock("../services/notifications.service.js", () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
}));

const { matchAndNotifySignal, describeSignal } = await import("./signal-alert-sweep.worker.js");

const CONFIG = {} as never;

/** Chainable select mock: `.select().from().where()` resolves `ownersResult`, a second
 * `.select().from().where().limit()` resolves the next entry of `ruleResults` (FIFO). */
function mockDb(ownersResult: unknown[], ruleResults: unknown[][]) {
  let ruleCallIndex = 0;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const chain = {
            limit: vi.fn(() => Promise.resolve(ruleResults[ruleCallIndex++] ?? [])),
          };
          // First call (owners lookup) has no .limit() in the real query — resolve directly too.
          return Object.assign(Promise.resolve(ownersResult), chain);
        }),
      })),
    })),
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("describeSignal", () => {
  it("prefers a plain-language reason when present (risk signals)", () => {
    expect(describeSignal({ signalType: "engagement_decay", value: { reason: "No activity in 21 days." } })).toEqual({
      title: "New engagement decay signal",
      body: "No activity in 21 days.",
    });
  });

  it("falls back to detail when there's no reason (corpus signals)", () => {
    expect(describeSignal({ signalType: "tech_adopted", value: { detail: "HubSpot" } })).toEqual({
      title: "New tech adopted signal",
      body: "HubSpot",
    });
  });
});

describe("matchAndNotifySignal", () => {
  const signal = {
    id: "sig-1",
    entityType: "prospect",
    entityId: "prospect-1",
    signalType: "engagement_decay",
    value: { reason: "No activity in 21 days." },
    confidence: null,
    detectedAt: new Date(),
    source: "risk-decay-sweep",
  };

  it("notifies the owning SDR when an enabled rule matches", async () => {
    const db = mockDb(
      [{ workspaceId: "ws-1", ownerId: "user-1" }],
      [[{ id: "rule-1", workspaceId: "ws-1", signalType: "engagement_decay", minConfidence: null, enabled: true }]]
    );

    const count = await matchAndNotifySignal(db as never, CONFIG, signal as never);

    expect(count).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(
      db,
      CONFIG,
      expect.objectContaining({ workspaceId: "ws-1", userId: "user-1", type: "signal_alert", entityId: "prospect-1" })
    );
  });

  it("does not notify when no alert_rule matches the signal type", async () => {
    const db = mockDb([{ workspaceId: "ws-1", ownerId: "user-1" }], [[]]);

    const count = await matchAndNotifySignal(db as never, CONFIG, signal as never);

    expect(count).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("skips a matching rule whose minConfidence exceeds the signal's confidence", async () => {
    const db = mockDb(
      [{ workspaceId: "ws-1", ownerId: "user-1" }],
      [[{ id: "rule-1", workspaceId: "ws-1", signalType: "engagement_decay", minConfidence: 0.8, enabled: true }]]
    );
    const lowConfidenceSignal = { ...signal, confidence: 0.5 } as never;

    const count = await matchAndNotifySignal(db as never, CONFIG, lowConfidenceSignal as never);

    expect(count).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("dedupes multiple activations sharing the same (workspace, owner) pair", async () => {
    const db = mockDb(
      [
        { workspaceId: "ws-1", ownerId: "user-1" },
        { workspaceId: "ws-1", ownerId: "user-1" },
      ],
      [[{ id: "rule-1", workspaceId: "ws-1", signalType: "engagement_decay", minConfidence: null, enabled: true }]]
    );

    const count = await matchAndNotifySignal(db as never, CONFIG, signal as never);

    expect(count).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
