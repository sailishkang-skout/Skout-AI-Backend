import { describe, expect, it, vi } from "vitest";
import {
  createReportSchedule,
  deleteReportSchedule,
  getReportSchedule,
  listReportSchedules,
  updateReportSchedule,
} from "./report-schedule.service.js";

const WORKSPACE = "ws-1";
const SCHEDULE_ID = "sched-1";

function selectChain(result: unknown[], terminal: "where" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

function updateReturning(result: unknown[]) {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }) };
}

const ROW = {
  id: SCHEDULE_ID,
  workspaceId: WORKSPACE,
  name: "Weekly CRO Rollup",
  cadence: "weekly",
  recipientEmails: ["cro@acme.com"],
  enabled: true,
  lastSentAt: null,
  nextSendAt: new Date("2026-01-08T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("createReportSchedule", () => {
  it("computes nextSendAt from the cadence when created enabled (default)", async () => {
    const db = { insert: vi.fn().mockReturnValue(insertReturning([ROW])) };
    const result = await createReportSchedule(db as never, WORKSPACE, {
      name: "Weekly CRO Rollup",
      cadence: "weekly",
      recipientEmails: ["cro@acme.com"],
    });
    expect(result.nextSendAt).toBe("2026-01-08T00:00:00.000Z");
    expect(result.enabled).toBe(true);
  });

  it("leaves nextSendAt null when created disabled", async () => {
    const disabledRow = { ...ROW, enabled: false, nextSendAt: null };
    const db = { insert: vi.fn().mockReturnValue(insertReturning([disabledRow])) };
    const result = await createReportSchedule(db as never, WORKSPACE, {
      name: "Weekly CRO Rollup",
      cadence: "weekly",
      recipientEmails: ["cro@acme.com"],
      enabled: false,
    });
    expect(result.nextSendAt).toBeNull();
  });
});

describe("listReportSchedules / getReportSchedule", () => {
  it("lists schedules for the workspace", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([ROW])) };
    const result = await listReportSchedules(db as never, WORKSPACE);
    expect(result).toHaveLength(1);
    expect(result[0]?.cadence).toBe("weekly");
  });

  it("returns null when not found", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await getReportSchedule(db as never, WORKSPACE, SCHEDULE_ID);
    expect(result).toBeNull();
  });
});

describe("updateReportSchedule", () => {
  it("returns null when the schedule doesn't exist", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await updateReportSchedule(db as never, WORKSPACE, SCHEDULE_ID, { name: "New" });
    expect(result).toBeNull();
  });

  it("does not touch nextSendAt on an unrelated field change", async () => {
    const db = {
      select: vi.fn().mockReturnValue(selectChain([ROW])),
      update: vi.fn().mockReturnValue(updateReturning([{ ...ROW, name: "Renamed" }])),
    };
    await updateReportSchedule(db as never, WORKSPACE, SCHEDULE_ID, { name: "Renamed" });
    const setSpy = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value.set;
    expect(setSpy).toHaveBeenCalledWith(expect.not.objectContaining({ nextSendAt: expect.anything() }));
  });

  it("restarts the clock when cadence changes", async () => {
    const db = {
      select: vi.fn().mockReturnValue(selectChain([ROW])),
      update: vi.fn().mockReturnValue(updateReturning([{ ...ROW, cadence: "daily" }])),
    };
    await updateReportSchedule(db as never, WORKSPACE, SCHEDULE_ID, { cadence: "daily" });
    const setSpy = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value.set;
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ nextSendAt: expect.any(Date) }));
  });

  it("restarts the clock when re-enabling a disabled schedule", async () => {
    const disabledRow = { ...ROW, enabled: false, nextSendAt: null };
    const db = {
      select: vi.fn().mockReturnValue(selectChain([disabledRow])),
      update: vi.fn().mockReturnValue(updateReturning([{ ...disabledRow, enabled: true }])),
    };
    await updateReportSchedule(db as never, WORKSPACE, SCHEDULE_ID, { enabled: true });
    const setSpy = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value.set;
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ nextSendAt: expect.any(Date) }));
  });

  it("clears nextSendAt when disabling", async () => {
    const db = {
      select: vi.fn().mockReturnValue(selectChain([ROW])),
      update: vi.fn().mockReturnValue(updateReturning([{ ...ROW, enabled: false, nextSendAt: null }])),
    };
    await updateReportSchedule(db as never, WORKSPACE, SCHEDULE_ID, { enabled: false });
    const setSpy = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value.set;
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ nextSendAt: null }));
  });
});

describe("deleteReportSchedule", () => {
  it("returns false when not found", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await deleteReportSchedule(db as never, WORKSPACE, SCHEDULE_ID);
    expect(result).toBe(false);
  });

  it("deletes an existing schedule", async () => {
    const db = {
      select: vi.fn().mockReturnValue(selectChain([ROW])),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    const result = await deleteReportSchedule(db as never, WORKSPACE, SCHEDULE_ID);
    expect(result).toBe(true);
    expect(db.delete).toHaveBeenCalled();
  });
});
