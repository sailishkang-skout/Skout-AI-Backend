import { describe, expect, it, vi, beforeEach } from "vitest";
import { AutomationService } from "./automation.service.js";
import type { AutomationGraph } from "./automation-graph.js";

const WORKSPACE_ID = "ws-1";
const EMPTY_GRAPH: AutomationGraph = { nodes: [], edges: [] };

function makeDb(overrides: Partial<Record<string, unknown>> = {}) {
  const returning = vi.fn().mockResolvedValue([{ id: "auto-1", workspaceId: WORKSPACE_ID, name: "Test", status: "draft", currentVersion: 0 }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  const limit = vi.fn().mockResolvedValue([{ id: "auto-1", workspaceId: WORKSPACE_ID, currentVersion: 0 }]);
  const where = vi.fn().mockReturnValue({ limit, orderBy: vi.fn().mockResolvedValue([]) });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const update = vi.fn().mockReturnValue({ set });
  return { insert, select, update, ...overrides } as any;
}

describe("AutomationService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an automation with status=draft and currentVersion=0", async () => {
    const db = makeDb();
    const svc = new AutomationService(db);
    const auto = await svc.createAutomation(WORKSPACE_ID, { name: "Test" });
    expect(auto.status).toBe("draft");
    expect(db.insert).toHaveBeenCalled();
  });

  it("publishVersion increments currentVersion and marks the version published", async () => {
    const versionReturning = vi.fn().mockResolvedValue([{ id: "v-1", automationId: "auto-1", version: 1, status: "published" }]);
    const versionValues = vi.fn().mockReturnValue({ returning: versionReturning });
    const db = makeDb({
      insert: vi.fn().mockReturnValue({ values: versionValues }),
    });
    const svc = new AutomationService(db);
    const version = await svc.publishVersion(WORKSPACE_ID, "auto-1", EMPTY_GRAPH);
    expect(version.status).toBe("published");
    expect(version.version).toBe(1);
  });

  it("getDraftVersion returns the draft row when one exists", async () => {
    const limit = vi.fn().mockResolvedValue([{ id: "v-0", automationId: "auto-1", version: 0, status: "draft", graph: EMPTY_GRAPH }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const db = makeDb({ select: vi.fn().mockReturnValue({ from }) });
    const svc = new AutomationService(db);
    const draft = await svc.getDraftVersion("auto-1");
    expect(draft?.status).toBe("draft");
    expect(draft?.version).toBe(0);
  });

  it("getDraftVersion returns null when no draft exists", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const db = makeDb({ select: vi.fn().mockReturnValue({ from }) });
    const svc = new AutomationService(db);
    expect(await svc.getDraftVersion("auto-1")).toBeNull();
  });
});
