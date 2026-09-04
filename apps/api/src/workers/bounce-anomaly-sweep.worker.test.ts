import { describe, expect, it, vi } from "vitest";
import type { IncidentsService } from "../services/incidents.service.js";
import { detectBounceSpike, sweepWorkspaceForBounceSpike } from "./bounce-anomaly-sweep.worker.js";

const OPTS = { minSent: 20, spikeDelta: 0.15 };
const SWEEP_CONFIG = { BOUNCE_ANOMALY_MIN_SENT: 20, BOUNCE_ANOMALY_SPIKE_DELTA: 0.15 };

describe("detectBounceSpike", () => {
  it("does not fire on normal variance (small delta under threshold)", () => {
    const result = detectBounceSpike({ sent: 100, bounces: 8 }, { sent: 400, bounces: 20 }, OPTS);
    // recentRate 8%, baselineRate 5%, delta 3pp < 15pp threshold
    expect(result.isSpike).toBe(false);
    expect(result.delta).toBeCloseTo(0.03, 5);
  });

  it("fires on a real spike (delta over threshold)", () => {
    const result = detectBounceSpike({ sent: 50, bounces: 15 }, { sent: 200, bounces: 10 }, OPTS);
    // recentRate 30%, baselineRate 5%, delta 25pp >= 15pp threshold
    expect(result.isSpike).toBe(true);
    expect(result.recentRate).toBeCloseTo(0.3, 5);
    expect(result.baselineRate).toBeCloseTo(0.05, 5);
  });

  it("fires exactly at the threshold boundary", () => {
    const result = detectBounceSpike({ sent: 100, bounces: 20 }, { sent: 100, bounces: 5 }, OPTS);
    // delta = 0.20 - 0.05 = 0.15, equal to spikeDelta
    expect(result.delta).toBeCloseTo(0.15, 5);
    expect(result.isSpike).toBe(true);
  });

  it("does not fire when the recent window has too little volume, even at an extreme rate", () => {
    const result = detectBounceSpike({ sent: 2, bounces: 1 }, { sent: 200, bounces: 10 }, OPTS);
    // recentRate 50% would otherwise look like a huge spike, but sent=2 < minSent=20
    expect(result.isSpike).toBe(false);
  });

  it("does not fire when the baseline window has too little volume", () => {
    const result = detectBounceSpike({ sent: 100, bounces: 30 }, { sent: 5, bounces: 0 }, OPTS);
    expect(result.isSpike).toBe(false);
  });

  it("treats zero-send windows as 0% rate rather than dividing by zero", () => {
    const result = detectBounceSpike({ sent: 0, bounces: 0 }, { sent: 0, bounces: 0 }, OPTS);
    expect(result.recentRate).toBe(0);
    expect(result.baselineRate).toBe(0);
    expect(result.isSpike).toBe(false);
  });
});

function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockResolvedValue(result);
  return c;
}

/** Mocks the four sequential db.select() calls sweepWorkspaceForBounceSpike makes:
 * recent-sent, recent-bounce, baseline-sent, baseline-bounce (in that order). */
function mockDb(recentSent: number, recentBounces: number, baselineSent: number, baselineBounces: number) {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m-${i}` }));
  const select = vi
    .fn()
    .mockReturnValueOnce(selectChain(rows(recentSent)))
    .mockReturnValueOnce(selectChain(rows(recentBounces)))
    .mockReturnValueOnce(selectChain(rows(baselineSent)))
    .mockReturnValueOnce(selectChain(rows(baselineBounces)));
  return { select } as never;
}

function mockIncidents(openIncidents: { source: string }[] = []) {
  return {
    list: vi.fn().mockResolvedValue(openIncidents),
    create: vi.fn().mockResolvedValue({ id: "incident-1" }),
  } as unknown as IncidentsService;
}

describe("sweepWorkspaceForBounceSpike", () => {
  it("opens a high-severity incident when a spike is detected and none is already open", async () => {
    const db = mockDb(50, 15, 200, 10); // recent 30%, baseline 5%, delta 25pp
    const incidents = mockIncidents([]);

    const fired = await sweepWorkspaceForBounceSpike(db, "ws-1", incidents, SWEEP_CONFIG);

    expect(fired).toBe(true);
    expect(incidents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        source: "bounce-anomaly-sweep",
        severity: "high",
      })
    );
  });

  it("escalates to critical severity when the delta is at least double the threshold", async () => {
    const db = mockDb(50, 20, 200, 10); // recent 40%, baseline 5%, delta 35pp >= 2x15pp
    const incidents = mockIncidents([]);

    await sweepWorkspaceForBounceSpike(db, "ws-1", incidents, SWEEP_CONFIG);

    expect(incidents.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
  });

  it("does not open a duplicate incident while one from this source is already open", async () => {
    const db = mockDb(50, 15, 200, 10); // would otherwise spike
    const incidents = mockIncidents([{ source: "bounce-anomaly-sweep" }]);

    const fired = await sweepWorkspaceForBounceSpike(db, "ws-1", incidents, SWEEP_CONFIG);

    expect(fired).toBe(false);
    expect(incidents.create).not.toHaveBeenCalled();
  });

  it("opens a new incident once an existing one is from a different source", async () => {
    const db = mockDb(50, 15, 200, 10);
    const incidents = mockIncidents([{ source: "manual" }]);

    const fired = await sweepWorkspaceForBounceSpike(db, "ws-1", incidents, SWEEP_CONFIG);

    expect(fired).toBe(true);
    expect(incidents.create).toHaveBeenCalled();
  });

  it("does nothing on normal variance, without even checking for an existing incident", async () => {
    const db = mockDb(100, 8, 400, 20); // delta 3pp, under threshold
    const incidents = mockIncidents([]);

    const fired = await sweepWorkspaceForBounceSpike(db, "ws-1", incidents, SWEEP_CONFIG);

    expect(fired).toBe(false);
    expect(incidents.list).not.toHaveBeenCalled();
    expect(incidents.create).not.toHaveBeenCalled();
  });
});
