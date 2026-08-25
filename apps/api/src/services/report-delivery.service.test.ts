import { beforeEach, describe, expect, it, vi } from "vitest";

const computeCroRollup = vi.fn();
const sendMail = vi.fn();

vi.mock("./cro-summary.service.js", () => ({ computeCroRollup }));
vi.mock("./mail.service.js", () => ({ sendMail }));

const { createReportSnapshot, deliverReportSchedule, listReportSnapshots } = await import(
  "./report-delivery.service.js"
);

const WORKSPACE = "ws-1";
const SCHEDULE_ID = "sched-1";
const config = {} as never;

function selectChain(result: unknown[], terminal: "where" | "orderBy" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.orderBy = terminal === "orderBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

const ROLLUP = {
  tamCoverage: { total: 100, activated: 40, enriched: 30, contacted: 20, replied: 5, dealCreated: 2 },
  activationRate: 0.4,
  responseRate: 0.25,
  topAtRiskAccounts: [],
  pipelineValue: 50000,
  currency: "USD",
  openDeals: 3,
};

const SCHEDULE_ROW = {
  id: SCHEDULE_ID,
  workspaceId: WORKSPACE,
  name: "Weekly CRO Rollup",
  cadence: "weekly",
  recipientEmails: ["a@acme.com", "b@acme.com"],
  enabled: true,
  lastSentAt: null,
  nextSendAt: new Date("2026-01-08T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  computeCroRollup.mockResolvedValue(ROLLUP);
});

describe("createReportSnapshot", () => {
  it("starts at version 1 for a schedule's first snapshot", async () => {
    const db = {
      select: vi.fn().mockReturnValue(selectChain([{ maxVersion: null }])),
      insert: vi.fn().mockReturnValue(insertReturning([{ id: "snap-1", scheduleId: SCHEDULE_ID, workspaceId: WORKSPACE, version: 1, rollup: ROLLUP, generatedAt: new Date() }])),
    };
    const snapshot = await createReportSnapshot(db as never, config, WORKSPACE, SCHEDULE_ID);
    expect(snapshot.version).toBe(1);
  });

  it("increments the version for a schedule's next snapshot", async () => {
    const db = {
      select: vi.fn().mockReturnValue(selectChain([{ maxVersion: 3 }])),
      insert: vi.fn().mockReturnValue(insertReturning([{ id: "snap-4", scheduleId: SCHEDULE_ID, workspaceId: WORKSPACE, version: 4, rollup: ROLLUP, generatedAt: new Date() }])),
    };
    const snapshot = await createReportSnapshot(db as never, config, WORKSPACE, SCHEDULE_ID);
    expect(snapshot.version).toBe(4);
  });

  it("uses version 1 and skips the version lookup for an ad-hoc (unscheduled) snapshot", async () => {
    const select = vi.fn();
    const db = {
      select,
      insert: vi.fn().mockReturnValue(insertReturning([{ id: "snap-x", scheduleId: null, workspaceId: WORKSPACE, version: 1, rollup: ROLLUP, generatedAt: new Date() }])),
    };
    const snapshot = await createReportSnapshot(db as never, config, WORKSPACE, null);
    expect(snapshot.version).toBe(1);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("listReportSnapshots", () => {
  it("returns snapshots newest-version first", async () => {
    const rows = [
      { id: "s2", scheduleId: SCHEDULE_ID, workspaceId: WORKSPACE, version: 2, rollup: ROLLUP, generatedAt: new Date() },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(rows, "orderBy")) };
    const result = await listReportSnapshots(db as never, WORKSPACE, SCHEDULE_ID);
    expect(result[0]?.version).toBe(2);
  });
});

describe("deliverReportSchedule", () => {
  it("snapshots the rollup, emails every recipient, and advances the schedule's clock", async () => {
    sendMail.mockResolvedValue({ sent: true });
    const snapshotRow = { id: "snap-1", scheduleId: SCHEDULE_ID, workspaceId: WORKSPACE, version: 1, rollup: ROLLUP, generatedAt: new Date() };
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([SCHEDULE_ROW])) // getReportSchedule
        .mockReturnValueOnce(selectChain([{ maxVersion: null }])), // version lookup inside createReportSnapshot
      insert: vi.fn().mockReturnValue(insertReturning([snapshotRow])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    };

    const result = await deliverReportSchedule(db as never, config, WORKSPACE, SCHEDULE_ID);

    expect(result.emailed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenCalledWith(config, expect.objectContaining({ to: "a@acme.com" }));
    const setSpy = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value.set;
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ lastSentAt: expect.any(Date), nextSendAt: expect.any(Date) }));
  });

  it("counts a failed send as skipped without failing the whole delivery", async () => {
    sendMail.mockResolvedValueOnce({ sent: true }).mockRejectedValueOnce(new Error("smtp down"));
    const snapshotRow = { id: "snap-1", scheduleId: SCHEDULE_ID, workspaceId: WORKSPACE, version: 1, rollup: ROLLUP, generatedAt: new Date() };
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain([SCHEDULE_ROW])).mockReturnValueOnce(selectChain([{ maxVersion: null }])),
      insert: vi.fn().mockReturnValue(insertReturning([snapshotRow])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    };

    const result = await deliverReportSchedule(db as never, config, WORKSPACE, SCHEDULE_ID);

    expect(result.emailed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("throws when the schedule doesn't exist", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    await expect(deliverReportSchedule(db as never, config, WORKSPACE, SCHEDULE_ID)).rejects.toThrow();
  });
});
