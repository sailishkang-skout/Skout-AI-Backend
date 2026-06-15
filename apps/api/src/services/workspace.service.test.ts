import { describe, expect, it, vi, beforeEach } from "vitest";
import { createWorkspaceService } from "./workspace.service.js";

// Chainable mock builders
function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.leftJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  // queries that end in .limit() resolve directly;
  // queries that chain .limit().offset() resolve at .offset()
  c.limit = vi.fn().mockReturnValue(
    Object.assign(Promise.resolve(result), {
      offset: vi.fn().mockResolvedValue(result),
    })
  );
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
    it("returns the updated workspace row", async () => {
      const updated = { id: "ws-1", name: "New Name", slug: "new-name-abc12" };
      const db = makeMockDb({ update: [updated] });
      const svc = createWorkspaceService(db as any);
      const result = await svc.renameWorkspace("ws-1", "New Name");
      expect(result).toEqual(updated);
    });

    it("returns null when workspace not found", async () => {
      const db = makeMockDb({ update: [] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.renameWorkspace("missing", "X")).toBeNull();
    });

    it("calls db.update once", async () => {
      const db = makeMockDb({ update: [{ id: "ws-1", name: "X", slug: "x-abc12" }] });
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
    it("returns the list of transactions", async () => {
      const rows = [
        { id: "ct-1", workspaceId: "ws-1", amount: 500, action: "provision", referenceId: null, createdAt: new Date() },
        { id: "ct-2", workspaceId: "ws-1", amount: -1,  action: "search",    referenceId: "job-1", createdAt: new Date() },
      ];
      const db = makeMockDb({ selects: [rows] });
      const svc = createWorkspaceService(db as any);
      const result = await svc.getCreditTransactions("ws-1");
      expect(result).toEqual(rows);
      expect(result).toHaveLength(2);
    });

    it("returns empty array when no transactions", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createWorkspaceService(db as any);
      expect(await svc.getCreditTransactions("ws-1")).toEqual([]);
    });
  });
});
