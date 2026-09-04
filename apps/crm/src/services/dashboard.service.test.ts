// apps/crm/src/services/dashboard.service.test.ts
import { describe, expect, it, vi } from "vitest";
import { DashboardService } from "./dashboard.service.js";

// Mirrors the mocked-db chain-builder convention from pipelines.service.test.ts: each chain
// method either returns itself (to keep chaining) or resolves with `result` at the given
// terminal method, matching how far dashboard.service.ts's queries actually chain.
function chain(result: unknown[], terminal: "limit" | "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
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
