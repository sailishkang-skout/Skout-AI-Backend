import { beforeEach, describe, expect, it, vi } from "vitest";

const computeCroRollup = vi.fn();
vi.mock("./cro-summary.service.js", () => ({ computeCroRollup }));

const { getForecast, listForecasts, refreshModelForecast, setManagerAdjustment, setRepCommitment } =
  await import("./forecast.service.js");
const { HttpError } = await import("../utils/http.js");

const WORKSPACE = "ws-1";
const PERIOD = "2026-08";
const config = {} as never;

function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockResolvedValue(result);
  return c;
}

function insertOnConflict(result: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }),
    }),
  };
}

function updateReturning(result: unknown[]) {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }) };
}

const ROLLUP = {
  tamCoverage: { total: 100, activated: 40, enriched: 30, contacted: 20, replied: 5, dealCreated: 2 },
  activationRate: 0.4,
  responseRate: 0.25,
  topAtRiskAccounts: [],
  pipelineValue: 80000,
  currency: "USD",
  openDeals: 4,
};

const FORECAST_ROW = {
  id: "fc-1",
  workspaceId: WORKSPACE,
  periodLabel: PERIOD,
  modelAmount: "80000.00",
  currency: "USD",
  managerAdjustedAmount: null,
  managerAdjustedReason: null,
  managerAdjustedBy: null,
  repCommittedAmount: null,
  repCommittedReason: null,
  repCommittedBy: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  computeCroRollup.mockResolvedValue(ROLLUP);
});

describe("refreshModelForecast", () => {
  it("upserts the model amount from the live rollup's pipeline value", async () => {
    const db = { insert: vi.fn().mockReturnValue(insertOnConflict([FORECAST_ROW])) };
    const result = await refreshModelForecast(db as never, config, WORKSPACE, PERIOD);
    expect(result.modelAmount).toBe(80000);
    expect(result.currency).toBe("USD");
    expect(result.managerAdjustedAmount).toBeNull();
    expect(result.managerGapToModel).toBeNull();
  });
});

describe("getForecast / listForecasts", () => {
  it("returns null when no forecast exists for the period", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await getForecast(db as never, WORKSPACE, PERIOD);
    expect(result).toBeNull();
  });

  it("computes the manager/rep gap-to-model when figures are set", async () => {
    const row = { ...FORECAST_ROW, managerAdjustedAmount: "95000.00", repCommittedAmount: "70000.00" };
    const db = { select: vi.fn().mockReturnValue(selectChain([row])) };
    const result = await getForecast(db as never, WORKSPACE, PERIOD);
    expect(result?.managerGapToModel).toBe(15000); // 95000 - 80000
    expect(result?.repGapToModel).toBe(-10000); // 70000 - 80000
  });

  it("lists all forecasts for the workspace", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([FORECAST_ROW])) };
    const result = await listForecasts(db as never, WORKSPACE);
    expect(result).toHaveLength(1);
  });
});

describe("setManagerAdjustment / setRepCommitment", () => {
  it("throws HttpError 404 when the forecast (model figure) doesn't exist yet", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    await expect(
      setManagerAdjustment(db as never, WORKSPACE, PERIOD, { amount: 90000, reason: "Q3 renewal push" })
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("records the manager's amount, reason, and author", async () => {
    const updated = {
      ...FORECAST_ROW,
      managerAdjustedAmount: "90000.00",
      managerAdjustedReason: "Q3 renewal push",
      managerAdjustedBy: "user-1",
    };
    const db = {
      select: vi.fn().mockReturnValue(selectChain([FORECAST_ROW])),
      update: vi.fn().mockReturnValue(updateReturning([updated])),
    };
    const result = await setManagerAdjustment(db as never, WORKSPACE, PERIOD, {
      amount: 90000,
      reason: "Q3 renewal push",
      userId: "user-1",
    });
    expect(result.managerAdjustedAmount).toBe(90000);
    expect(result.managerAdjustedReason).toBe("Q3 renewal push");
    expect(result.managerGapToModel).toBe(10000);
  });

  it("records the rep's committed amount independently of the manager figure", async () => {
    const updated = {
      ...FORECAST_ROW,
      repCommittedAmount: "72000.00",
      repCommittedReason: "2 deals slipping to next quarter",
      repCommittedBy: "user-2",
    };
    const db = {
      select: vi.fn().mockReturnValue(selectChain([FORECAST_ROW])),
      update: vi.fn().mockReturnValue(updateReturning([updated])),
    };
    const result = await setRepCommitment(db as never, WORKSPACE, PERIOD, {
      amount: 72000,
      reason: "2 deals slipping to next quarter",
      userId: "user-2",
    });
    expect(result.repCommittedAmount).toBe(72000);
    expect(result.repGapToModel).toBe(-8000);
  });
});
