// apps/crm/src/services/dashboard.service.test.ts
import { describe, expect, it, vi } from "vitest";
import { DashboardService } from "./dashboard.service.js";

// Mirrors the mocked-db chain-builder convention from pipelines.service.test.ts: each chain
// method either returns itself (to keep chaining) or resolves with `result` at the given
// terminal method, matching how far dashboard.service.ts's queries actually chain.
function chain(result: unknown[], terminal: "limit" | "where") {
  const c: Record<string, unknown> = {};
  // All chain methods always return the chain object except the terminal method which resolves
  const alwaysReturnChain = vi.fn().mockReturnValue(c);
  c.from = alwaysReturnChain;
  c.innerJoin = alwaysReturnChain;
  c.leftJoin = alwaysReturnChain;
  c.orderBy = alwaysReturnChain;
  c.groupBy = alwaysReturnChain;
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : alwaysReturnChain;
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : alwaysReturnChain;
  return c;
}

function buildService(dealsRows: unknown[], contactRows: unknown[], linkedRows: unknown[]) {
  const db = { select: vi.fn() };
  // Call order inside missingStakeholders(): (1) open deals, (2) company contacts, (3) buying
  // committee members joined to their committee — the latter two run inside a Promise.all in
  // that array order, so they're still issued sequentially against the same mock.
  db.select.mockReturnValueOnce(chain(dealsRows, "limit"));
  db.select.mockReturnValueOnce(chain(contactRows, "where"));
  db.select.mockReturnValueOnce(chain(linkedRows, "where"));
  return new DashboardService(db as any, {} as any, {} as any, {} as any, null);
}

const DEAL = { id: "deal-1", name: "Acme Renewal", companyId: "company-1" };
const DECISION_MAKER = {
  id: "contact-dm",
  companyId: "company-1",
  title: "VP of Engineering",
  firstName: "Dana",
  lastName: "Maker",
};
const NON_DECISION_MAKER = {
  id: "contact-eval",
  companyId: "company-1",
  title: "Sales Rep",
  firstName: "Evan",
  lastName: "Evaluator",
};

describe("DashboardService.missingStakeholders", () => {
  it("flags a deal whose account has a Decision Maker not linked to the deal", async () => {
    const svc = buildService([DEAL], [DECISION_MAKER, NON_DECISION_MAKER], []);

    const flags = await svc.missingStakeholders("ws-1");

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      dealId: "deal-1",
      dealName: "Acme Renewal",
      companyId: "company-1",
      contactId: "contact-dm",
      contactName: "Dana Maker",
      accountRole: "Decision Maker",
      rule: "decision_maker_not_linked_to_deal",
    });
    expect(typeof flags[0]!.computedAt).toBe("string");
    expect(new Date(flags[0]!.computedAt).toString()).not.toBe("Invalid Date");
  });

  it("does not flag a deal where the Decision Maker is already linked to it", async () => {
    const svc = buildService(
      [DEAL],
      [DECISION_MAKER, NON_DECISION_MAKER],
      [{ dealId: "deal-1", contactId: "contact-dm" }]
    );

    const flags = await svc.missingStakeholders("ws-1");

    expect(flags).toHaveLength(0);
  });

  it("returns no flags and skips further queries when there are no open deals", async () => {
    const db = { select: vi.fn() };
    db.select.mockReturnValueOnce(chain([], "limit"));
    const svc = new DashboardService(db as any, {} as any, {} as any, {} as any, null);

    const flags = await svc.missingStakeholders("ws-1");

    expect(flags).toHaveLength(0);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("does not flag an account with no Decision Maker role present at all", async () => {
    const svc = buildService([DEAL], [NON_DECISION_MAKER], []);

    const flags = await svc.missingStakeholders("ws-1");

    expect(flags).toHaveLength(0);
  });
});

describe("DashboardService.pipelineVelocity", () => {
  it("delegates to DealsService.pipelineVelocity with the workspace and day count", async () => {
    const series = [{ date: "2026-09-01", value: 500 }];
    const dealsService = { pipelineVelocity: vi.fn().mockResolvedValue(series) };
    const svc = new DashboardService({} as any, dealsService as any, {} as any, {} as any, null);

    const result = await svc.pipelineVelocity("ws-1", 14);

    expect(dealsService.pipelineVelocity).toHaveBeenCalledWith("ws-1", 14);
    expect(result).toBe(series);
  });
});

// New tests for SS-10 retention workflow flags
describe("DashboardService.disengagementFlags", () => {
  function buildDisengagementService(companiesRows: unknown[], activitiesRows: unknown[]) {
    const db = { select: vi.fn() };
    // First call: get companies, second call: get activities (query ends with groupBy, so use that as terminal)
    db.select.mockReturnValueOnce(chain(companiesRows, "limit"));
    // Create a chain where groupBy is the terminal method that resolves with activitiesRows
    const c: Record<string, unknown> = {};
    const alwaysReturnChain = vi.fn().mockReturnValue(c);
    c.from = alwaysReturnChain;
    c.innerJoin = alwaysReturnChain;
    c.leftJoin = alwaysReturnChain;
    c.orderBy = alwaysReturnChain;
    c.where = alwaysReturnChain;
    c.limit = alwaysReturnChain;
    c.groupBy = vi.fn().mockResolvedValue(activitiesRows);
    db.select.mockReturnValueOnce(c);
    return new DashboardService(db as any, {} as any, {} as any, {} as any, null);
  }

  const COMPANY = { id: "company-1", name: "Acme Corp" };
  const OLD_ACTIVITY = { entityId: "company-1", lastActivityAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) }; // 40 days ago (Date object)

  it("flags a company with no recent activity (>30 days)", async () => {
    const svc = buildDisengagementService([COMPANY], [OLD_ACTIVITY]);

    const flags = await svc.disengagementFlags("ws-1");

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      companyId: "company-1",
      companyName: "Acme Corp",
      daysSinceActivity: 40,
      rule: "company_inactivity_exceeds_threshold",
    });
    expect(typeof flags[0]!.computedAt).toBe("string");
  });

  it("returns no flags when there are no companies", async () => {
    const svc = buildDisengagementService([], []);

    const flags = await svc.disengagementFlags("ws-1");

    expect(flags).toHaveLength(0);
  });
});

describe("DashboardService.renewalRiskFlags", () => {
  function buildRenewalService(dealsRows: unknown[], companiesRows: unknown[]) {
    const db = { select: vi.fn() };
    // First call: get expiring deals, second call: get companies
    db.select.mockReturnValueOnce(chain(dealsRows, "limit"));
    db.select.mockReturnValueOnce(chain(companiesRows, "where"));
    return new DashboardService(db as any, {} as any, {} as any, {} as any, null);
  }

  const WON_DEAL = { 
    id: "deal-1", 
    name: "Acme Renewal", 
    companyId: "company-1", 
    contractEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // Expires in 30 days
    status: "won",
    amount: "50000",
    currency: "USD"
  };
  const COMPANY = { id: "company-1", name: "Acme Corp" };

  it("flags a deal expiring within 90 days", async () => {
    const svc = buildRenewalService([WON_DEAL], [COMPANY]);

    const flags = await svc.renewalRiskFlags("ws-1");

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      dealId: "deal-1",
      dealName: "Acme Renewal",
      companyId: "company-1",
      companyName: "Acme Corp",
      daysUntilExpiry: 30,
      rule: "contract_expiring_within_renewal_window",
      amount: 50000,
      currency: "USD",
    });
    expect(typeof flags[0]!.computedAt).toBe("string");
  });

  it("returns no flags when there are no expiring deals", async () => {
    const svc = buildRenewalService([], []);

    const flags = await svc.renewalRiskFlags("ws-1");

    expect(flags).toHaveLength(0);
  });
});

describe("DashboardService.expansionSignalFlags", () => {
  function buildExpansionService(signalRows: unknown[]) {
    const db = { select: vi.fn() };
    // One call with chained joins, returns signal rows directly
    db.select.mockReturnValueOnce(chain(signalRows, "limit"));
    return new DashboardService(db as any, {} as any, {} as any, {} as any, null);
  }

  const SIGNAL = {
    id: "signal-1",
    entityId: "company-1",
    signalType: "website_traffic_spike",
    detectedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago (Date object, not ISO string)
    companyName: "Acme Corp",
  };

  it("flags a company with recent expansion signals", async () => {
    const svc = buildExpansionService([SIGNAL]);

    const flags = await svc.expansionSignalFlags("ws-1");

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      companyId: "company-1",
      companyName: "Acme Corp",
      signalType: "website_traffic_spike",
      rule: "growth_signal_detected_recently",
    });
    expect(typeof flags[0]!.computedAt).toBe("string");
  });

  it("returns no flags when there are no recent signals", async () => {
    const svc = buildExpansionService([]);

    const flags = await svc.expansionSignalFlags("ws-1");

    expect(flags).toHaveLength(0);
  });
});