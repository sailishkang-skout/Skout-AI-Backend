import { beforeEach, describe, expect, it, vi } from "vitest";

const createNotification = vi.fn().mockResolvedValue({ id: "notif-1" });
const listSignalsForEntities = vi.fn();

vi.mock("../services/notifications.service.js", () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
}));

vi.mock("../services/signal.service.js", () => ({
  listSignalsForEntities: (...args: unknown[]) => listSignalsForEntities(...args),
}));

const {
  computeDisengagementCandidates,
  computeRenewalRiskCandidates,
  computeExpansionCandidates,
  sweepDisengagement,
  sweepRenewalRisk,
  sweepExpansion,
} = await import("./retention-signals-sweep.worker.js");

const CONFIG = {} as never;
const NOW = new Date("2026-06-01T00:00:00.000Z");

// Mirrors the chain-builder convention from pipelines.service.test.ts / dashboard.service.test.ts:
// each chain method either returns itself or resolves with `result` at the given terminal method.
function chain(result: unknown[], terminal: "where" | "orderBy" | "limit" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.orderBy = terminal === "orderBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function dbWithSelects(...results: { rows: unknown[]; terminal?: "where" | "orderBy" | "limit" }[]) {
  const db = { select: vi.fn() };
  for (const r of results) db.select.mockReturnValueOnce(chain(r.rows, r.terminal ?? "where"));
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  createNotification.mockResolvedValue({ id: "notif-1" });
  vi.setSystemTime(NOW);
});

describe("computeDisengagementCandidates", () => {
  const ACCOUNT = {
    id: "company-1",
    name: "Acme Inc",
    ownerId: "user-1",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
  };

  it("flags an active account with no activity in the configured window", async () => {
    const db = dbWithSelects(
      { rows: [ACCOUNT] }, // companies
      { rows: [] }, // deals
      { rows: [] }, // contacts
      { rows: [{ entityId: "company-1", lastAt: new Date("2026-01-01T00:00:00.000Z") }], terminal: "orderBy" } // activities
    );

    const candidates = await computeDisengagementCandidates(db as never, "ws-1", 30);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ companyId: "company-1", companyName: "Acme Inc" });
  });

  it("does not flag an account with recent activity", async () => {
    const db = dbWithSelects(
      { rows: [ACCOUNT] },
      { rows: [] },
      { rows: [] },
      { rows: [{ entityId: "company-1", lastAt: new Date("2026-05-25T00:00:00.000Z") }], terminal: "orderBy" }
    );

    const candidates = await computeDisengagementCandidates(db as never, "ws-1", 30);

    expect(candidates).toHaveLength(0);
  });

  it("counts activity on the account's deals/contacts, not just the company entity", async () => {
    const db = dbWithSelects(
      { rows: [ACCOUNT] },
      { rows: [{ id: "deal-1", companyId: "company-1" }] },
      { rows: [] },
      { rows: [{ entityId: "deal-1", lastAt: new Date("2026-05-25T00:00:00.000Z") }], terminal: "orderBy" }
    );

    const candidates = await computeDisengagementCandidates(db as never, "ws-1", 30);

    expect(candidates).toHaveLength(0);
  });
});

describe("computeRenewalRiskCandidates", () => {
  const DEAL = {
    id: "deal-1",
    name: "Acme Renewal",
    companyId: "company-1",
    ownerId: "user-1",
    contractEndDate: "2026-06-20",
  };

  it("flags a won deal whose contract end date is within the window with no recent positive signal", async () => {
    const db = dbWithSelects(
      { rows: [DEAL] }, // deals
      { rows: [] }, // meetings
      { rows: [{ id: "company-1", sourceProspectCompanyId: null }] }, // companies
      // no inboxThreads select — corpusIds is empty since sourceProspectCompanyId is null
    );

    const candidates = await computeRenewalRiskCandidates(db as never, "ws-1", 60, 30);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ dealId: "deal-1", contractEndDate: "2026-06-20" });
  });

  it("does not flag when a recent meeting exists on the deal", async () => {
    const db = dbWithSelects(
      { rows: [DEAL] },
      { rows: [{ dealId: "deal-1", companyId: null }] }, // meetings
      { rows: [{ id: "company-1", sourceProspectCompanyId: null }] }
    );

    const candidates = await computeRenewalRiskCandidates(db as never, "ws-1", 60, 30);

    expect(candidates).toHaveLength(0);
  });

  it("does not flag when a recent positive reply exists on the account", async () => {
    const db = dbWithSelects(
      { rows: [DEAL] },
      { rows: [] }, // meetings
      { rows: [{ id: "company-1", sourceProspectCompanyId: "corpus-1" }] }, // companies
      { rows: [{ prospectId: "corpus-1" }] } // inboxThreads (positive replies)
    );

    const candidates = await computeRenewalRiskCandidates(db as never, "ws-1", 60, 30);

    expect(candidates).toHaveLength(0);
  });
});

describe("computeExpansionCandidates", () => {
  const CUSTOMER = { id: "company-1", name: "Acme Inc", ownerId: "user-1", sourceProspectCompanyId: "corpus-1" };

  it("flags an existing customer with a new hiring/funding-shaped signal", async () => {
    const db = dbWithSelects({ rows: [CUSTOMER] });
    listSignalsForEntities.mockResolvedValue(
      new Map([["corpus-1", [{ signalType: "headcount_growth", detectedAt: "2026-05-28T00:00:00.000Z" }]]])
    );

    const candidates = await computeExpansionCandidates(db as never, "ws-1", 14);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ companyId: "company-1", signalType: "headcount_growth" });
  });

  it("does not flag a customer with no matching signal", async () => {
    const db = dbWithSelects({ rows: [CUSTOMER] });
    listSignalsForEntities.mockResolvedValue(new Map([["corpus-1", [{ signalType: "engagement_decay", detectedAt: "2026-05-28T00:00:00.000Z" }]]]));

    const candidates = await computeExpansionCandidates(db as never, "ws-1", 14);

    expect(candidates).toHaveLength(0);
  });

  it("does not flag a customer whose matching signal is outside the lookback window", async () => {
    const db = dbWithSelects({ rows: [CUSTOMER] });
    listSignalsForEntities.mockResolvedValue(
      new Map([["corpus-1", [{ signalType: "headcount_growth", detectedAt: "2026-01-01T00:00:00.000Z" }]]])
    );

    const candidates = await computeExpansionCandidates(db as never, "ws-1", 14);

    expect(candidates).toHaveLength(0);
  });

  it("skips customers with no linked corpus company id, without calling the signal engine", async () => {
    const db = dbWithSelects({ rows: [{ ...CUSTOMER, sourceProspectCompanyId: null }] });

    const candidates = await computeExpansionCandidates(db as never, "ws-1", 14);

    expect(candidates).toHaveLength(0);
    expect(listSignalsForEntities).not.toHaveBeenCalled();
  });
});

describe("sweep* notification + dedupe behavior", () => {
  it("sweepDisengagement creates a notification and dedupes against a recent one already sent", async () => {
    const account = { id: "company-1", name: "Acme Inc", ownerId: "user-1", createdAt: new Date("2025-01-01T00:00:00.000Z") };
    const db = dbWithSelects(
      { rows: [account] }, // companies
      { rows: [] }, // deals
      { rows: [] }, // contacts
      { rows: [], terminal: "orderBy" }, // activities (none at all)
      { rows: [], terminal: "limit" } // mostRecentNotification -> none yet
    );

    const flagged = await sweepDisengagement(db as never, CONFIG, "ws-1", 30);

    expect(flagged).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(
      db,
      CONFIG,
      expect.objectContaining({ workspaceId: "ws-1", type: "retention_disengagement_risk", entityType: "company", entityId: "company-1" })
    );
  });

  it("sweepDisengagement skips a candidate already notified within the inactivity window", async () => {
    const account = { id: "company-1", name: "Acme Inc", ownerId: "user-1", createdAt: new Date("2025-01-01T00:00:00.000Z") };
    const db = dbWithSelects(
      { rows: [account] },
      { rows: [] },
      { rows: [] },
      { rows: [], terminal: "orderBy" },
      { rows: [{ createdAt: new Date("2026-05-20T00:00:00.000Z") }], terminal: "limit" } // recent notification, inside 30-day window
    );

    const flagged = await sweepDisengagement(db as never, CONFIG, "ws-1", 30);

    expect(flagged).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("sweepExpansion creates an expansion notification for a flagged customer", async () => {
    const customer = { id: "company-1", name: "Acme Inc", ownerId: "user-1", sourceProspectCompanyId: "corpus-1" };
    const db = dbWithSelects(
      { rows: [customer] }, // companies
      { rows: [], terminal: "limit" } // mostRecentNotification -> none yet
    );
    listSignalsForEntities.mockResolvedValue(
      new Map([["corpus-1", [{ signalType: "headcount_growth", detectedAt: "2026-05-28T00:00:00.000Z" }]]])
    );

    const flagged = await sweepExpansion(db as never, CONFIG, "ws-1", 14);

    expect(flagged).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(
      db,
      CONFIG,
      expect.objectContaining({ type: "retention_expansion_opportunity", entityType: "company", entityId: "company-1" })
    );
  });

  it("sweepRenewalRisk creates a renewal-risk notification for a flagged deal", async () => {
    const deal = { id: "deal-1", name: "Acme Renewal", companyId: "company-1", ownerId: "user-1", contractEndDate: "2026-06-20" };
    const db = dbWithSelects(
      { rows: [deal] }, // deals
      { rows: [] }, // meetings
      { rows: [{ id: "company-1", sourceProspectCompanyId: null }] }, // companies
      { rows: [], terminal: "limit" } // mostRecentNotification -> none yet
    );

    const flagged = await sweepRenewalRisk(db as never, CONFIG, "ws-1", 60, 30);

    expect(flagged).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(
      db,
      CONFIG,
      expect.objectContaining({ type: "retention_renewal_risk", entityType: "deal", entityId: "deal-1" })
    );
  });
});
