import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import type { Db } from "@skout/db";
import type { Env } from "../config/env.js";
import type { CroRollup } from "./cro-summary.service.js";
import { createReportSnapshot, type ReportSnapshotRecord } from "./report-delivery.service.js";
import { getForecast, type RevenueForecastRecord } from "./forecast.service.js";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF_CONTENT_TYPE = "application/pdf";

export type BoardPackFormat = "pdf" | "xlsx";

export interface BoardPackInput {
  workspaceName?: string;
  periodLabel: string;
  generatedAt: Date;
  version: number;
  rollup: CroRollup;
  forecast: RevenueForecastRecord | null;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * The board pack's narrative panel — plain-English sentences a CRO/board member can read
 * without cross-referencing the tables, generated straight from the rollup (never hand-authored
 * per export, so it can't drift out of sync with the numbers next to it).
 */
export function buildNarrative(input: BoardPackInput): string[] {
  const { rollup, forecast } = input;
  const t = rollup.tamCoverage;
  const lines = [
    `Of ${t.total.toLocaleString()} accounts in view, ${t.activated.toLocaleString()} (${pct(rollup.activationRate)}) have been activated into outreach.`,
    `Response rate is ${pct(rollup.responseRate)} across ${t.contacted.toLocaleString()} contacted accounts, with ${t.replied.toLocaleString()} replies received and ${t.dealCreated.toLocaleString()} deals created so far.`,
    `Open pipeline totals ${rollup.pipelineValue.toLocaleString()} ${rollup.currency} across ${rollup.openDeals.toLocaleString()} open deals.`,
  ];

  if (rollup.topAtRiskAccounts.length > 0) {
    const atRiskValue = rollup.topAtRiskAccounts.reduce((sum, a) => sum + a.pipelineValue, 0);
    lines.push(
      `${rollup.topAtRiskAccounts.length} accounts are flagged at-risk (no recent activity), representing ${atRiskValue.toLocaleString()} ${rollup.currency} of open pipeline.`
    );
  } else {
    lines.push("No accounts are currently flagged at-risk.");
  }

  if (forecast) {
    lines.push(`Model-generated forecast for ${input.periodLabel} is ${forecast.modelAmount.toLocaleString()} ${forecast.currency}.`);
    if (forecast.managerAdjustedAmount != null) {
      const gap = forecast.managerGapToModel ?? 0;
      lines.push(
        `Manager has adjusted this to ${forecast.managerAdjustedAmount.toLocaleString()} ${forecast.currency} (${gap >= 0 ? "+" : ""}${gap.toLocaleString()} vs. model) — reason: ${forecast.managerAdjustedReason ?? "not given"}.`
      );
    }
    if (forecast.repCommittedAmount != null) {
      const gap = forecast.repGapToModel ?? 0;
      lines.push(
        `Rep-committed figure is ${forecast.repCommittedAmount.toLocaleString()} ${forecast.currency} (${gap >= 0 ? "+" : ""}${gap.toLocaleString()} vs. model) — reason: ${forecast.repCommittedReason ?? "not given"}.`
      );
    }
  }

  return lines;
}

/**
 * A board pack is only trustworthy if it says where its numbers came from. Answers the two
 * questions a reader would otherwise have to ask separately: is the TAM figure a real live count
 * or a local demo number, and how was "at-risk" defined.
 */
export function buildDataScopeDisclosure(input: BoardPackInput): string[] {
  const { rollup } = input;
  const tamSourceText =
    rollup.tamSource === "opensearch"
      ? "a live query against the OpenSearch prospect index"
      : "the local demo corpus (no OpenSearch index configured for this workspace)";
  return [
    `Total addressable market (TAM = ${rollup.tamCoverage.total.toLocaleString()}) is sourced from ${tamSourceText}. This is the full corpus size, not yet filtered to ICP fit — treat it as a coverage denominator, not a qualified market count.`,
    `"At-risk" accounts are the top 50 accounts by open pipeline value, ranked by days since their last logged activity across the account, its deals, and its contacts.`,
    `Snapshot generated ${input.generatedAt.toISOString()} (version ${input.version}), workspace: ${input.workspaceName ?? "unlabeled"}.`,
  ];
}

export function buildBoardPackInput(
  snapshot: ReportSnapshotRecord,
  forecast: RevenueForecastRecord | null,
  workspaceName?: string
): BoardPackInput {
  return {
    workspaceName,
    periodLabel: forecast?.periodLabel ?? new Date(snapshot.generatedAt).toISOString().slice(0, 7),
    generatedAt: new Date(snapshot.generatedAt),
    version: snapshot.version,
    rollup: snapshot.rollup,
    forecast,
  };
}

export function renderBoardPackPdf(input: BoardPackInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).fillColor("#1B1D1F").text("Board Pack");
    doc.fontSize(11).fillColor("#63676D").text(`${input.workspaceName ?? "Workspace"} · ${input.periodLabel}`);
    doc.moveDown(1.2);

    doc.fontSize(14).fillColor("#1B1D1F").text("Summary");
    doc.moveDown(0.3);
    doc.fontSize(10.5).fillColor("#1B1D1F");
    for (const line of buildNarrative(input)) {
      doc.text(`• ${line}`, { paragraphGap: 4 });
    }

    doc.moveDown(0.8);
    doc.fontSize(14).text("TAM Coverage");
    doc.moveDown(0.3);
    doc.fontSize(10.5);
    const t = input.rollup.tamCoverage;
    doc.text(`Total: ${t.total.toLocaleString()}`);
    doc.text(`Activated: ${t.activated.toLocaleString()}`);
    doc.text(`Enriched: ${t.enriched.toLocaleString()}`);
    doc.text(`Contacted: ${t.contacted.toLocaleString()}`);
    doc.text(`Replied: ${t.replied.toLocaleString()}`);
    doc.text(`Deals created: ${t.dealCreated.toLocaleString()}`);

    doc.moveDown(0.8);
    doc.fontSize(14).text("Top At-Risk Accounts");
    doc.moveDown(0.3);
    doc.fontSize(10.5);
    if (input.rollup.topAtRiskAccounts.length === 0) {
      doc.text("None.");
    } else {
      for (const acc of input.rollup.topAtRiskAccounts) {
        const days = acc.daysSinceLastActivity != null ? `${acc.daysSinceLastActivity} days since activity` : "no logged activity";
        doc.text(`${acc.name} — ${acc.pipelineValue.toLocaleString()} ${acc.currency} — ${days}`);
      }
    }

    if (input.forecast) {
      doc.moveDown(0.8);
      doc.fontSize(14).text("Forecast");
      doc.moveDown(0.3);
      doc.fontSize(10.5);
      doc.text(`Model: ${input.forecast.modelAmount.toLocaleString()} ${input.forecast.currency}`);
      if (input.forecast.managerAdjustedAmount != null) {
        doc.text(`Manager-adjusted: ${input.forecast.managerAdjustedAmount.toLocaleString()} ${input.forecast.currency} — ${input.forecast.managerAdjustedReason ?? ""}`);
      }
      if (input.forecast.repCommittedAmount != null) {
        doc.text(`Rep-committed: ${input.forecast.repCommittedAmount.toLocaleString()} ${input.forecast.currency} — ${input.forecast.repCommittedReason ?? ""}`);
      }
    }

    doc.moveDown(0.8);
    doc.fontSize(14).fillColor("#1B1D1F").text("Data Scope & Disclosure");
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor("#63676D");
    for (const line of buildDataScopeDisclosure(input)) {
      doc.text(line, { paragraphGap: 4 });
    }

    doc.end();
  });
}

export async function renderBoardPackXlsx(input: BoardPackInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Skout AI";
  wb.created = input.generatedAt;

  const summary = wb.addWorksheet("Summary");
  summary.columns = [{ width: 100 }];
  summary.addRow([`Board Pack — ${input.workspaceName ?? "Workspace"} · ${input.periodLabel}`]);
  summary.addRow([]);
  for (const line of buildNarrative(input)) summary.addRow([line]);

  const tam = wb.addWorksheet("TAM Coverage");
  tam.addRow(["Stage", "Count"]);
  const t = input.rollup.tamCoverage;
  tam.addRow(["Total", t.total]);
  tam.addRow(["Activated", t.activated]);
  tam.addRow(["Enriched", t.enriched]);
  tam.addRow(["Contacted", t.contacted]);
  tam.addRow(["Replied", t.replied]);
  tam.addRow(["Deals created", t.dealCreated]);

  const risk = wb.addWorksheet("At-Risk Accounts");
  risk.addRow(["Account", "Pipeline Value", "Currency", "Days Since Activity"]);
  for (const acc of input.rollup.topAtRiskAccounts) {
    risk.addRow([acc.name, acc.pipelineValue, acc.currency, acc.daysSinceLastActivity ?? "—"]);
  }

  if (input.forecast) {
    const fc = wb.addWorksheet("Forecast");
    fc.addRow(["Figure", "Amount", "Currency", "Reason"]);
    fc.addRow(["Model", input.forecast.modelAmount, input.forecast.currency, ""]);
    if (input.forecast.managerAdjustedAmount != null) {
      fc.addRow(["Manager-adjusted", input.forecast.managerAdjustedAmount, input.forecast.currency, input.forecast.managerAdjustedReason ?? ""]);
    }
    if (input.forecast.repCommittedAmount != null) {
      fc.addRow(["Rep-committed", input.forecast.repCommittedAmount, input.forecast.currency, input.forecast.repCommittedReason ?? ""]);
    }
  }

  const scope = wb.addWorksheet("Data Scope");
  scope.columns = [{ width: 120 }];
  for (const line of buildDataScopeDisclosure(input)) scope.addRow([line]);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function renderBoardPack(input: BoardPackInput, format: BoardPackFormat): Promise<Buffer> {
  return format === "xlsx" ? renderBoardPackXlsx(input) : renderBoardPackPdf(input);
}

export interface BoardPackExportOptions {
  format: BoardPackFormat;
  periodLabel?: string;
  workspaceName?: string;
}

export interface BoardPackExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** Ad-hoc board-pack export: snapshots the live rollup (scheduleId null, same as any other
 * on-demand snapshot) and pulls the period's forecast split if one has been saved. */
export async function generateBoardPack(
  db: Db,
  config: Env,
  workspaceId: string,
  options: BoardPackExportOptions
): Promise<BoardPackExportResult> {
  const snapshot = await createReportSnapshot(db, config, workspaceId, null);
  const periodLabel = options.periodLabel ?? new Date().toISOString().slice(0, 7);
  const forecast = await getForecast(db, workspaceId, periodLabel);

  const input: BoardPackInput = {
    workspaceName: options.workspaceName,
    periodLabel,
    generatedAt: new Date(snapshot.generatedAt),
    version: snapshot.version,
    rollup: snapshot.rollup,
    forecast,
  };

  const buffer = await renderBoardPack(input, options.format);
  const filename = `board-pack-${periodLabel}.${options.format}`;
  const contentType = options.format === "xlsx" ? XLSX_CONTENT_TYPE : PDF_CONTENT_TYPE;
  return { buffer, filename, contentType };
}
