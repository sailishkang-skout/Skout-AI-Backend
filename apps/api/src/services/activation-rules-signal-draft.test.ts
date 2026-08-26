import { describe, expect, it, vi } from "vitest";
import type { Env } from "../config/env.js";

const enrollMock = vi.fn().mockResolvedValue({ enrolled: 1 });
vi.mock("./sequence.service.js", () => ({
  buildSequenceService: vi.fn(() => ({ enroll: enrollMock })),
}));

const personalizeMock = vi.fn().mockResolvedValue({ draftId: "draft-1" });
vi.mock("./personalize.service.js", () => ({
  personalizeProspect: personalizeMock,
}));

const { executeActivationRules } = await import("./activation-rules.service.js");

const config = {} as unknown as Env;

function selectChain(result: unknown[], terminal: "where" | "limit" = "limit") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

const SIGNAL_RULE = {
  id: "rule-1",
  workspaceId: "ws-1",
  name: "Hiring signal -> outbound",
  scoreThreshold: 0,
  signalType: "recent_hiring",
  targetAction: "enroll_sequence",
  targetId: "seq-1",
  enabled: true,
  createdBy: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const SIGNAL_ROW = {
  id: "sig-1",
  entityType: "prospect",
  entityId: "prospect-1",
  signalType: "recent_hiring",
  value: { reason: "3 new engineering hires in the last 30 days" },
  confidence: 0.8,
  observedAt: new Date("2026-01-01T00:00:00Z"),
  detectedAt: new Date("2026-01-01T00:00:00Z"),
  source: "test",
  provenance: {},
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: null,
  activationPaths: [],
};

describe("executeActivationRules — R10.3 signal-triggered draft", () => {
  it("enrolls the prospect and generates a pending-review AI draft citing the signal's reason", async () => {
    enrollMock.mockClear();
    personalizeMock.mockClear();

    let call = 0;
    const db = {
      select: vi.fn(() => {
        call++;
        // 1: listActivationRules, 2: listSignalsForEntity, 3: buildSnapshotForActivate (prospectActivations)
        if (call === 1) return selectChain([SIGNAL_RULE], "where");
        if (call === 2) return selectChain([SIGNAL_ROW]);
        return selectChain([]);
      }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "run-1" }]) })) })),
    };

    const outcome = await executeActivationRules(db as never, config, "ws-1", "prospect-1", 90, ["recent_hiring"]);

    expect(outcome).toEqual({ matched: 1, executed: 1, failed: 0 });
    expect(enrollMock).toHaveBeenCalledWith("seq-1", "ws-1", { prospectIds: ["prospect-1"] });
    expect(personalizeMock).toHaveBeenCalledTimes(1);
    expect(personalizeMock).toHaveBeenCalledWith(
      db,
      config,
      "ws-1",
      expect.objectContaining({
        prospectId: "prospect-1",
        painPoints: ["3 new engineering hires in the last 30 days"],
      })
    );
  });

  it("passes the prospect's stored country through as companyCountry (R10.3 regional tone)", async () => {
    enrollMock.mockClear();
    personalizeMock.mockClear();

    let call = 0;
    const db = {
      select: vi.fn(() => {
        call++;
        if (call === 1) return selectChain([SIGNAL_RULE], "where");
        if (call === 2) return selectChain([SIGNAL_ROW]);
        // 3: buildSnapshotForActivate — a prior activation with a stored country.
        return selectChain([{ snapshot: { companyDomain: "acme.com", country: "DE" }, companyId: "acme.com" }]);
      }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "run-1" }]) })) })),
    };

    await executeActivationRules(db as never, config, "ws-1", "prospect-1", 90, ["recent_hiring"]);

    expect(personalizeMock).toHaveBeenCalledWith(
      db,
      config,
      "ws-1",
      expect.objectContaining({ companyCountry: "DE" })
    );
  });

  it("still counts the rule as executed when draft generation fails — enrollment isn't undone", async () => {
    enrollMock.mockClear();
    personalizeMock.mockClear();
    personalizeMock.mockRejectedValueOnce(new Error("ai down"));

    let call = 0;
    const db = {
      select: vi.fn(() => {
        call++;
        if (call === 1) return selectChain([SIGNAL_RULE], "where");
        if (call === 2) return selectChain([SIGNAL_ROW]);
        return selectChain([]);
      }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "run-1" }]) })) })),
    };

    const outcome = await executeActivationRules(db as never, config, "ws-1", "prospect-1", 90, ["recent_hiring"]);

    expect(outcome).toEqual({ matched: 1, executed: 1, failed: 0 });
    expect(enrollMock).toHaveBeenCalledTimes(1);
  });
});
