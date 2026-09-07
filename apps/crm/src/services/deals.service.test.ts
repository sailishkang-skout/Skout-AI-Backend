import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./skout-event.service.js", () => ({
  emitSkoutEvent: vi.fn(async (_config: unknown, input: unknown) => ({ id: "evt-1", ...(input as object) })),
}));
vi.mock("@skout/db", async () => {
  const actual = await vi.importActual<typeof import("@skout/db")>("@skout/db");
  return { ...actual, recordEvidence: vi.fn(async () => {}) };
});

import { emitSkoutEvent } from "./skout-event.service.js";
import { DealsService } from "./deals.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const EXISTING_ROW = {
  id: "deal-1",
  workspaceId: "ws-1",
  companyId: "company-1",
  pipelineId: "pipeline-1",
  stageId: "stage-1",
  ownerId: "user-1",
  name: "Acme renewal",
  amount: "1000",
  currency: "USD",
  closeDate: null,
  probability: null,
  status: "open",
  fieldSources: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeUpdateDb(updatedRow: Record<string, unknown>) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([EXISTING_ROW]) }) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updatedRow]) }) }),
    }),
  };
}

function buildService(db: unknown, config?: unknown) {
  const auditService = { record: vi.fn() };
  const activitiesService = { record: vi.fn() };
  return new DealsService(db as any, {} as any, {} as any, activitiesService as any, auditService as any, config as any);
}

describe("DealsService.update — event spine", () => {
  it("emits opportunity.updated when a deal is successfully updated", async () => {
    const updatedRow = { ...EXISTING_ROW, amount: "2000" };
    const db = makeUpdateDb(updatedRow);
    const svc = buildService(db, { REDIS_URL: "redis://localhost:6379" });

    await svc.update("ws-1", "deal-1", { amount: 2000 } as any, "user-1");

    expect(emitSkoutEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "opportunity.updated",
        tenantId: "ws-1",
        aggregateId: "deal-1",
        data: expect.objectContaining({ dealId: "deal-1", stageId: "stage-1", amount: 2000, updatedBy: "user-1" }),
      })
    );
  });

  it("does not emit when the service has no config (event spine unset)", async () => {
    const updatedRow = { ...EXISTING_ROW, amount: "2000" };
    const db = makeUpdateDb(updatedRow);
    const svc = buildService(db, undefined);

    await svc.update("ws-1", "deal-1", { amount: 2000 } as any, "user-1");

    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });
});
