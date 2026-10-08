import { describe, expect, it, vi, beforeEach } from "vitest";
import { schema } from "@skout/db";

vi.mock("./skout-event.service.js", () => ({
  emitSkoutEvent: vi.fn(async (_db: unknown, _config: unknown, input: unknown) => ({
    id: "evt-1",
    ...(input as object),
  })),
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

function makeUpdateDb(updatedRow: Record<string, unknown>, stageNames: string[] = []) {
  let stageIndex = 0;
  const outboxRows: Record<string, unknown>[] = [];
  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updatedRow]) }) }),
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        if (table === schema.copsOutbox) {
          outboxRows.push(value);
          return Promise.resolve();
        }
          if (table === schema.copsLifecycleStates) {
            return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
          }
        return {
          returning: vi.fn().mockResolvedValue([{
            id: "audit-1",
            workspaceId: "ws-1",
            actorId: "user-1",
            action: "update",
            entityType: "deal",
            entityId: "deal-1",
            beforeState: null,
            afterState: null,
            createdAt: new Date(),
          }]),
        };
      }),
    })),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () => [{ name: stageNames[stageIndex++] }]),
        }),
      }),
    }),
  };
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([EXISTING_ROW]) }) }),
    }),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { ...db, tx, outboxRows };
}

function buildService(db: unknown, config?: unknown) {
  const auditService = { record: vi.fn() };
  const activitiesService = { record: vi.fn() };
  return new DealsService(db as any, {} as any, {} as any, activitiesService as any, auditService as any, config as any);
}

describe("DealsService.pipelineVelocity", () => {
  it("zero-fills days with no new pipeline and places real values on the right date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([{ day: today, value: "1500.00" }]),
          }),
        }),
      }),
    };
    const svc = buildService(db);

    const series = await svc.pipelineVelocity("ws-1", 7);

    expect(series).toHaveLength(7);
    expect(series[series.length - 1]).toEqual({ date: today, value: 1500 });
    expect(series.slice(0, -1).every((d) => d.value === 0)).toBe(true);
  });
});

describe("DealsService.createdCount", () => {
  it("counts deals created within the trailing window, across currencies and statuses", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }]),
        }),
      }),
    };
    const svc = buildService(db);

    const count = await svc.createdCount("ws-1", 30);

    expect(count).toBe(3);
  });

  it("returns 0 when no deals were created in the window", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    const svc = buildService(db);

    expect(await svc.createdCount("ws-1")).toBe(0);
  });
});

describe("DealsService.update — event spine", () => {
  it("emits opportunity.updated when a deal is successfully updated", async () => {
    const updatedRow = { ...EXISTING_ROW, amount: "2000" };
    const db = makeUpdateDb(updatedRow);
    const svc = buildService(db, { REDIS_URL: "redis://localhost:6379" });

    await svc.update("ws-1", "deal-1", { amount: 2000 } as any, "user-1");

    expect(emitSkoutEvent).toHaveBeenCalledWith(
      expect.anything(),
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

  it("writes OpportunityQualified to the outbox in the stage-change transaction", async () => {
    const updatedRow = { ...EXISTING_ROW, stageId: "stage-2" };
    const db = makeUpdateDb(updatedRow, ["New", "Qualified"]);
    const svc = buildService(db);

    await svc.update("ws-1", "deal-1", { stageId: "stage-2" } as any, "user-1");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.tx.insert).toHaveBeenCalledWith(schema.copsOutbox);
    expect(db.tx.insert).toHaveBeenCalledWith(schema.copsLifecycleStates);
    expect(db.outboxRows[0]).toMatchObject({
      eventType: "OpportunityQualified",
      tenantId: "ws-1",
      aggregateType: "opportunity",
      aggregateId: "deal-1",
      envelope: {
        event_type: "OpportunityQualified",
        payload: { opportunity_id: "deal-1", account_id: "company-1" },
      },
    });
  });
});
