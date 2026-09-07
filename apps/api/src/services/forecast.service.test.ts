import { beforeEach, describe, expect, it, vi } from "vitest";

const computeCroRollup = vi.fn();
vi.mock("./cro-summary.service.js", () => ({ computeCroRollup }));

const {
  getForecast,
  getForecastDetail,
  computeForecastUncertainty,
  computeForecastDataGaps,
  listForecasts,
  refreshModelForecast,
  setManagerAdjustment,
  setRepCommitment,
} = await import("./forecast.service.js");
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

// Mirrors the chain-builder convention used by SS-01/SS-02's tests: each chain method either
// returns itself (to keep chaining) or resolves with `result` at the given terminal method.
function chain(result: unknown[], terminal: "where" | "limit" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

describe("computeForecastUncertainty", () => {
  it("computes a real standard-deviation band from two comparable historical periods", async () => {
    const priorPeriods = [
      { periodLabel: "2026-Q2", modelAmount: "100000.00" },
      { periodLabel: "2026-Q1", modelAmount: "80000.00" },
    ];
    const db = { select: vi.fn() };
    db.select.mockReturnValueOnce(chain(priorPeriods, "limit"));
    db.select.mockReturnValueOnce(chain([{ actual: "110000" }], "where")); // Q2 actual: +10% vs model
    db.select.mockReturnValueOnce(chain([{ actual: "72000" }], "where")); // Q1 actual: -10% vs model

    const result = await computeForecastUncertainty(db as never, WORKSPACE, "2026-Q3", 90000);

    expect(result).not.toBeNull();
    expect(result!.sampleSize).toBe(2);
    expect(result!.percentage).toBeCloseTo(0.1, 5);
    expect(result!.amount).toBe(9000);
    expect(result!.lowerBound).toBe(81000);
    expect(result!.upperBound).toBe(99000);
    expect(result!.periods).toEqual(["2026-Q2", "2026-Q1"]);
  });

  it("returns null (not a fabricated 0%) when fewer than two periods are comparable", async () => {
    const db = { select: vi.fn() };
    db.select.mockReturnValueOnce(chain([{ periodLabel: "2026-Q1", modelAmount: "80000.00" }], "limit"));
    db.select.mockReturnValueOnce(chain([{ actual: "72000" }], "where"));

    const result = await computeForecastUncertainty(db as never, WORKSPACE, "2026-Q3", 90000);

    expect(result).toBeNull();
  });

  it("skips a period whose label doesn't parse as YYYY-MM or YYYY-QN, without querying its actuals", async () => {
    const db = { select: vi.fn() };
    db.select.mockReturnValueOnce(
      chain(
        [
          { periodLabel: "not-a-period", modelAmount: "80000.00" },
          { periodLabel: "2026-Q1", modelAmount: "80000.00" },
        ],
        "limit"
      )
    );
    db.select.mockReturnValueOnce(chain([{ actual: "72000" }], "where"));

    const result = await computeForecastUncertainty(db as never, WORKSPACE, "2026-Q3", 90000);

    expect(result).toBeNull(); // only 1 valid period after the skip
    expect(db.select).toHaveBeenCalledTimes(2); // no wasted query for the unparseable label
  });

  it("skips a period with a zero model amount (would divide by zero)", async () => {
    const db = { select: vi.fn() };
    db.select.mockReturnValueOnce(
      chain(
        [
          { periodLabel: "2026-Q1", modelAmount: "0.00" },
          { periodLabel: "2026-Q2", modelAmount: "50000.00" },
        ],
        "limit"
      )
    );
    db.select.mockReturnValueOnce(chain([{ actual: "55000" }], "where"));

    const result = await computeForecastUncertainty(db as never, WORKSPACE, "2026-Q3", 90000);

    expect(result).toBeNull();
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

describe("computeForecastDataGaps", () => {
  it("flags a deal missing amount and closeDate", async () => {
    const rows = [
      { id: "deal-1", name: "Acme", amount: null, closeDate: null, probability: 50, stageProbability: 40 },
    ];
    const db = { select: vi.fn().mockReturnValue(chain(rows, "limit")) };

    const gaps = await computeForecastDataGaps(db as never, WORKSPACE);

    expect(gaps).toEqual([{ dealId: "deal-1", dealName: "Acme", missingFields: ["amount", "closeDate"] }]);
  });

  it("does not flag a deal with amount, closeDate, and a stage probability signal", async () => {
    const rows = [
      { id: "deal-1", name: "Acme", amount: "5000.00", closeDate: "2026-09-01", probability: null, stageProbability: 40 },
    ];
    const db = { select: vi.fn().mockReturnValue(chain(rows, "limit")) };

    const gaps = await computeForecastDataGaps(db as never, WORKSPACE);

    expect(gaps).toHaveLength(0);
  });

  it("flags 'stage' when neither the deal's own probability nor its stage's probability is set", async () => {
    const rows = [
      { id: "deal-1", name: "Acme", amount: "5000.00", closeDate: "2026-09-01", probability: null, stageProbability: 0 },
    ];
    const db = { select: vi.fn().mockReturnValue(chain(rows, "limit")) };

    const gaps = await computeForecastDataGaps(db as never, WORKSPACE);

    expect(gaps).toEqual([{ dealId: "deal-1", dealName: "Acme", missingFields: ["stage"] }]);
  });

  it("returns an empty list when no open deals have gaps", async () => {
    const db = { select: vi.fn().mockReturnValue(chain([], "limit")) };

    const gaps = await computeForecastDataGaps(db as never, WORKSPACE);

    expect(gaps).toEqual([]);
  });
});

describe("getForecastDetail", () => {
  it("returns null when no forecast exists for the period, without computing insights", async () => {
    const db = { select: vi.fn().mockReturnValue(chain([], "where")) };

    const result = await getForecastDetail(db as never, WORKSPACE, PERIOD);

    expect(result).toBeNull();
  });

  it("composes the plain forecast with a null uncertainty and empty data gaps when there's no history/no open deals", async () => {
    const db = { select: vi.fn() };
    db.select.mockReturnValueOnce(chain([FORECAST_ROW], "where")); // getForecast
    db.select.mockReturnValueOnce(chain([], "limit")); // computeForecastUncertainty's prior periods
    db.select.mockReturnValueOnce(chain([], "limit")); // computeForecastDataGaps

    const result = await getForecastDetail(db as never, WORKSPACE, PERIOD);

    expect(result).not.toBeNull();
    expect(result!.modelAmount).toBe(80000);
    expect(result!.uncertainty).toBeNull();
    expect(result!.dataGaps).toEqual([]);
  });
});
