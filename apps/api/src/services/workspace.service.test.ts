import { describe, expect, it, vi, beforeEach } from "vitest";
import { createWorkspaceService } from "./workspace.service.js";

// Chainable mock builders
function selectChain(result: unknown[]) {
  const limitPromise = Object.assign(Promise.resolve(result), {
    offset: vi.fn().mockResolvedValue(result),
  });
  const orderChain = {
    limit: vi.fn().mockReturnValue(limitPromise),
  };
  const whereResult = Object.assign(Promise.resolve(result), {
    orderBy: vi.fn().mockReturnValue(orderChain),
    limit: vi.fn().mockReturnValue(limitPromise),
  });
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.leftJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(whereResult);
  c.orderBy = vi.fn().mockReturnValue(orderChain);
  c.limit = vi.fn().mockReturnValue(limitPromise);
  return c;
}

function updateChain(result: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function insertChain(result: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function makeMockDb(overrides: {
  selects?: unknown[][];
  update?: unknown[];
  insert?: unknown[];
} = {}) {
  const db = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  };

  for (const result of overrides.selects ?? []) {
    db.select.mockReturnValueOnce(selectChain(result));
  }
  if (overrides.update !== undefined) {
    db.update.mockReturnValue(updateChain(overrides.update));
  }
  if (overrides.insert !== undefined) {
    db.insert.mockReturnValue(insertChain(overrides.insert));
  }

  return db;
}

const WORKSPACE = {
  id: "ws-1",
  name: "Acme",
  slug: "acme",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

describe("createWorkspaceService", () => {
  describe("getWorkspaceById", () => {
    it("returns the workspace when found", async () => {
      const db = makeMockDb({ selects: [[WORKSPACE]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getWorkspaceById("ws-1")).toEqual(WORKSPACE);
    });

    it("returns null when not found", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getWorkspaceById("missing")).toBeNull();
    });
  });

  describe("getWorkspaceWithCredits", () => {
    it("returns combined workspace + balance row", async () => {
      const row = { id: "ws-1", name: "Acme", slug: "acme", createdAt: new Date(), balance: 500 };
      const db = makeMockDb({ selects: [[row]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getWorkspaceWithCredits("ws-1")).toEqual(row);
    });

    it("returns null when workspace does not exist", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getWorkspaceWithCredits("missing")).toBeNull();
    });
  });

  describe("renameWorkspace", () => {
    it("returns the updated workspace with credits", async () => {
      const updated = { id: "ws-1", name: "New Name", slug: "new-name-abc12" };
      const withCredits = {
        id: "ws-1",
        name: "New Name",
        slug: "new-name-abc12",
        createdAt: new Date("2026-01-01"),
        balance: 500,
      };
      const db = makeMockDb({ update: [updated], selects: [[withCredits]] });
      const svc = createWorkspaceService(db as any);
      const result = await svc.renameWorkspace("ws-1", "New Name");
      expect(result).toEqual(withCredits);
    });

    it("returns null when workspace not found", async () => {
      const db = makeMockDb({ update: [] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.renameWorkspace("missing", "X")).toBeNull();
    });

    it("calls db.update once", async () => {
      const withCredits = {
        id: "ws-1",
        name: "X",
        slug: "x-abc12",
        createdAt: new Date("2026-01-01"),
        balance: 100,
      };
      const db = makeMockDb({
        update: [{ id: "ws-1", name: "X", slug: "x-abc12" }],
        selects: [[withCredits]],
      });
      const svc = createWorkspaceService(db as any);
      await svc.renameWorkspace("ws-1", "X");
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("getIcp", () => {
    it("returns the ICP row when present", async () => {
      const row = { workspaceId: "ws-1", config: { industries: ["SaaS"] }, version: 1, updatedAt: new Date() };
      const db = makeMockDb({ selects: [[row]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getIcp("ws-1")).toEqual(row);
    });

    it("returns null when ICP row is absent", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getIcp("ws-1")).toBeNull();
    });
  });

  describe("upsertIcp", () => {
    it("returns the upserted ICP row", async () => {
      const config = { industries: ["Software"], countries: ["US"] };
      const returned = { workspaceId: "ws-1", config, version: 1, updatedAt: new Date() };
      const db = makeMockDb({ insert: [returned] });
      const svc = createWorkspaceService(db as any);
      const result = await svc.upsertIcp("ws-1", config);
      expect(result).toEqual(returned);
    });

    it("calls db.insert once", async () => {
      const db = makeMockDb({ insert: [{ workspaceId: "ws-1", config: {}, version: 1, updatedAt: new Date() }] });
      const svc = createWorkspaceService(db as any);
      await svc.upsertIcp("ws-1", {});
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCreditBalance", () => {
    it("returns balance and updatedAt when row exists", async () => {
      const row = { balance: 420, updatedAt: new Date("2026-06-01") };
      const db = makeMockDb({ selects: [[row]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getCreditBalance("ws-1")).toEqual(row);
    });

    it("returns 0 balance when no row found", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createWorkspaceService(db as any);
      const result = await svc.getCreditBalance("ws-1");
      expect(result.balance).toBe(0);
    });
  });

  describe("getCreditTransactions", () => {
    it("returns paginated transactions with total count", async () => {
      const createdAt = new Date("2026-06-16T09:43:39.151Z");
      const rows = [
        { id: "ct-1", workspaceId: "ws-1", amount: 500, action: "provision", referenceId: null, createdAt },
        { id: "ct-2", workspaceId: "ws-1", amount: -1,  action: "search",    referenceId: "job-1", createdAt },
      ];
      const db = makeMockDb({ selects: [[{ total: 2 }], rows] });
      const svc = createWorkspaceService(db as any);
      const result = await svc.getCreditTransactions("ws-1", 50, 0);
      expect(result.total).toBe(2);
      expect(result.data).toEqual([
        { ...rows[0], createdAt: createdAt.toISOString() },
        { ...rows[1], createdAt: createdAt.toISOString() },
      ]);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it("returns empty data when no transactions", async () => {
      const db = makeMockDb({ selects: [[{ total: 0 }], []] });
      const svc = createWorkspaceService(db as any);
      const result = await svc.getCreditTransactions("ws-1");
      expect(result).toEqual({ data: [], total: 0, limit: 50, offset: 0 });
    });
  });
});
