import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

const createReportSnapshot = vi.fn();
const getForecast = vi.fn();

vi.mock("./report-delivery.service.js", () => ({ createReportSnapshot }));
vi.mock("./forecast.service.js", () => ({ getForecast }));

const {
  buildDataScopeDisclosure,
  buildNarrative,
  generateBoardPack,
  renderBoardPackPdf,
  renderBoardPackXlsx,
} = await import("./board-pack-export.service.js");

const WORKSPACE = "ws-1";
const config = {} as never;

const ROLLUP = {
  tamCoverage: { total: 100, activated: 40, enriched: 30, contacted: 20, replied: 5, dealCreated: 2 },
  activationRate: 0.4,
  responseRate: 0.25,
  tamSource: "opensearch" as const,
  topAtRiskAccounts: [
    { companyId: "c-1", name: "Acme Corp", pipelineValue: 50000, currency: "USD", daysSinceLastActivity: 21 },
  ],
  pipelineValue: 80000,
  currency: "USD",
  openDeals: 4,
};

const FORECAST = {
  id: "fc-1",
  workspaceId: WORKSPACE,
  periodLabel: "2026-08",
  modelAmount: 80000,
  currency: "USD",
  managerAdjustedAmount: 90000,
  managerAdjustedReason: "Q3 renewal push",
  managerAdjustedBy: "user-1",
  managerGapToModel: 10000,
  repCommittedAmount: null,
  repCommittedReason: null,
  repCommittedBy: null,
  repGapToModel: null,
  uncertainty: null,
  dataGaps: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const BASE_INPUT = {
  workspaceName: "Acme Workspace",
  periodLabel: "2026-08",
  generatedAt: new Date("2026-08-24T00:00:00Z"),
  version: 3,
  rollup: ROLLUP,
  forecast: FORECAST,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildNarrative", () => {
  it("summarizes activation, response, and pipeline with the correct percentages and totals", () => {
    const lines = buildNarrative(BASE_INPUT);
    expect(lines[0]).toContain("40%");
    expect(lines[1]).toContain("25%");
    expect(lines.join(" ")).toContain("80,000 USD");
  });

  it("summarizes the at-risk pipeline value", () => {
    const lines = buildNarrative(BASE_INPUT);
    const line = lines.find((l) => l.includes("at-risk"));
    expect(line).toContain("50,000 USD");
  });

  it("includes the manager-adjusted gap and reason when set", () => {
    const lines = buildNarrative(BASE_INPUT);
    const line = lines.find((l) => l.includes("Manager has adjusted"));
    expect(line).toContain("90,000");
    expect(line).toContain("Q3 renewal push");
  });

  it("states plainly when no accounts are at-risk", () => {
    const lines = buildNarrative({ ...BASE_INPUT, rollup: { ...ROLLUP, topAtRiskAccounts: [] } });
    expect(lines).toContain("No accounts are currently flagged at-risk.");
  });

  it("omits forecast sentences when no forecast exists", () => {
    const lines = buildNarrative({ ...BASE_INPUT, forecast: null });
    expect(lines.some((l) => l.includes("forecast"))).toBe(false);
  });
});

describe("buildDataScopeDisclosure", () => {
  it("discloses a live OpenSearch source", () => {
    const lines = buildDataScopeDisclosure(BASE_INPUT);
    expect(lines.join(" ")).toContain("live query against the OpenSearch prospect index");
  });

  it("discloses the demo corpus fallback when no OpenSearch index is configured", () => {
    const lines = buildDataScopeDisclosure({ ...BASE_INPUT, rollup: { ...ROLLUP, tamSource: "demo_corpus" } });
    expect(lines.join(" ")).toContain("local demo corpus");
  });

  it("states the at-risk ranking definition and snapshot version", () => {
    const lines = buildDataScopeDisclosure(BASE_INPUT);
    expect(lines.join(" ")).toContain("top 50 accounts by open pipeline value");
    expect(lines.join(" ")).toContain("version 3");
  });
});

describe("renderBoardPackPdf", () => {
  it("produces a valid PDF buffer", async () => {
    const buffer = await renderBoardPackPdf(BASE_INPUT);
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });
});

describe("renderBoardPackXlsx", () => {
  it("produces a workbook with Summary, TAM Coverage, At-Risk Accounts, Forecast, and Data Scope sheets", async () => {
    const buffer = await renderBoardPackXlsx(BASE_INPUT);
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exceljs bundles a duplicate @types/node whose Buffer type structurally diverges from ours
    await wb.xlsx.load(buffer as any);
    const names = wb.worksheets.map((s) => s.name);
    expect(names).toEqual(["Summary", "TAM Coverage", "At-Risk Accounts", "Forecast", "Data Scope"]);

    const risk = wb.getWorksheet("At-Risk Accounts")!;
    expect(risk.getRow(2).getCell(1).value).toBe("Acme Corp");
  });

  it("omits the Forecast sheet when no forecast exists", async () => {
    const buffer = await renderBoardPackXlsx({ ...BASE_INPUT, forecast: null });
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exceljs bundles a duplicate @types/node whose Buffer type structurally diverges from ours
    await wb.xlsx.load(buffer as any);
    expect(wb.worksheets.map((s) => s.name)).not.toContain("Forecast");
  });
});

describe("generateBoardPack", () => {
  it("snapshots the live rollup and pulls the period's forecast for a PDF export", async () => {
    createReportSnapshot.mockResolvedValue({
      id: "snap-1",
      scheduleId: null,
      workspaceId: WORKSPACE,
      version: 1,
      rollup: ROLLUP,
      generatedAt: "2026-08-24T00:00:00.000Z",
    });
    getForecast.mockResolvedValue(FORECAST);

    const result = await generateBoardPack({} as never, config, WORKSPACE, { format: "pdf", periodLabel: "2026-08" });

    expect(createReportSnapshot).toHaveBeenCalledWith({}, config, WORKSPACE, null);
    expect(getForecast).toHaveBeenCalledWith({}, WORKSPACE, "2026-08");
    expect(result.filename).toBe("board-pack-2026-08.pdf");
    expect(result.contentType).toBe("application/pdf");
    expect(result.buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("defaults the period label to the current month when none is given", async () => {
    createReportSnapshot.mockResolvedValue({
      id: "snap-1",
      scheduleId: null,
      workspaceId: WORKSPACE,
      version: 1,
      rollup: ROLLUP,
      generatedAt: "2026-08-24T00:00:00.000Z",
    });
    getForecast.mockResolvedValue(null);

    const result = await generateBoardPack({} as never, config, WORKSPACE, { format: "xlsx" });
    const nowMonth = new Date().toISOString().slice(0, 7);
    expect(result.filename).toBe(`board-pack-${nowMonth}.xlsx`);
    expect(result.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });
});
