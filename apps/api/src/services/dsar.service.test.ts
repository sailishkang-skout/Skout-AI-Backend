import { describe, expect, it, vi } from "vitest";
import { DsarService } from "./dsar.service.js";

/** Thenable query chain: every builder method returns itself; awaiting (or .limit) yields `result`. */
function chain(result: unknown) {
  const c: any = {};
  for (const m of ["from", "where", "orderBy", "limit", "set", "values", "returning"]) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

/** selects/updates/inserts are consumed in call order. */
function makeDb(opts: { selects?: unknown[]; inserts?: unknown[]; updates?: unknown[] }) {
  const selects = [...(opts.selects ?? [])];
  const inserts = [...(opts.inserts ?? [])];
  const updates = [...(opts.updates ?? [])];
  const updateChains: any[] = [];
  const db: any = {
    select: vi.fn(() => chain(selects.shift())),
    insert: vi.fn(() => chain(inserts.shift())),
    update: vi.fn(() => {
      const c = chain(updates.shift());
      updateChains.push(c);
      return c;
    }),
    __updateChains: updateChains,
  };
  return db;
}

const now = new Date("2026-09-21T00:00:00Z");
function dsarRow(over: Record<string, unknown> = {}) {
  return {
    id: "d1", workspaceId: "ws-1", requestType: "access", subjectEmail: "a@example.com",
    subjectType: "prospect", subjectId: null, status: "received", fulfillmentMode: "auto",
    slaDueAt: now, exportPayload: null, exportCompletedAt: null, notes: null, requestedBy: null,
    completedAt: null, createdAt: now, updatedAt: now, ...over,
  };
}

describe("DsarService.create", () => {
  it("rejects a duplicate open request for the same email + type with 409", async () => {
    const db = makeDb({ selects: [[{ id: "existing" }]] });
    await expect(
      new DsarService(db).create("ws-1", { requestType: "erasure", subjectEmail: "A@Example.com" })
    ).rejects.toMatchObject({ statusCode: 409, message: "dsar_already_open" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("creates a manual erasure request in 'received' without running the export", async () => {
    const db = makeDb({
      selects: [[]],
      inserts: [[dsarRow({ requestType: "erasure", fulfillmentMode: "manual" })]],
    });
    const out = await new DsarService(db).create("ws-1", { requestType: "erasure", subjectEmail: "a@example.com" });
    expect(out.status).toBe("received");
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("DsarService.runAutoExport", () => {
  it("completes the request when consents are found", async () => {
    const consent = { id: "c1", type: "email", basis: "legitimate_interest", grantedAt: now, revokedAt: null };
    const db = makeDb({
      selects: [[dsarRow()], [consent], []],
      updates: [[dsarRow({ status: "completed" })]],
    });
    await new DsarService(db).runAutoExport("ws-1", "d1");
    const set = db.__updateChains[0].set.mock.calls[0][0];
    expect(set.status).toBe("completed");
    expect(JSON.parse(set.exportPayload).consents).toHaveLength(1);
  });

  it("completes when only a suppression record exists and includes it in the export", async () => {
    const supp = { reason: "unsubscribed", createdAt: now };
    const db = makeDb({ selects: [[dsarRow()], [], [supp]], updates: [[dsarRow({ status: "completed" })]] });
    await new DsarService(db).runAutoExport("ws-1", "d1");
    const set = db.__updateChains[0].set.mock.calls[0][0];
    expect(set.status).toBe("completed");
    expect(JSON.parse(set.exportPayload).suppression.reason).toBe("unsubscribed");
  });

  it("stays in_progress with a manual-review note when nothing was found", async () => {
    const db = makeDb({ selects: [[dsarRow()], [], []], updates: [[dsarRow({ status: "in_progress" })]] });
    await new DsarService(db).runAutoExport("ws-1", "d1");
    const set = db.__updateChains[0].set.mock.calls[0][0];
    expect(set.status).toBe("in_progress");
    expect(set.completedAt).toBeNull();
    expect(set.exportCompletedAt).toBeNull();
    expect(set.notes).toMatch(/manual review/i);
    expect(JSON.parse(set.exportPayload).note).toMatch(/manual review required/i);
  });

  it("404s for an unknown request", async () => {
    const db = makeDb({ selects: [[]] });
    await expect(new DsarService(db).runAutoExport("ws-1", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("DsarService.updateStatus", () => {
  it("sets completedAt for completed/rejected and clears it otherwise", async () => {
    for (const [status, expectDate] of [["completed", true], ["rejected", true], ["in_progress", false]] as const) {
      const db = makeDb({ updates: [[dsarRow({ status })]] });
      await new DsarService(db).updateStatus("ws-1", "d1", status);
      const set = db.__updateChains[0].set.mock.calls[0][0];
      expect(set.completedAt instanceof Date).toBe(expectDate);
    }
  });

  it("404s when the request is not in this workspace", async () => {
    const db = makeDb({ updates: [[]] });
    await expect(new DsarService(db).updateStatus("ws-1", "x", "completed")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
