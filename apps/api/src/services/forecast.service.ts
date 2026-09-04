import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { computeCroRollup } from "./cro-summary.service.js";

const { deals, pipelineStages, revenueForecasts } = schema;

/**
 * §7.1/§5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md for the full policy and the other confirmed instances.
 *   - Tables read directly: deals, pipelineStages (both owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has read-only access via the shared Postgres instance;
 *     this file only reads these tables — writes go to apps/api-owned revenueForecasts)
 *   - Reason: forecast enrichment (uncertainty bands, data-gap detection) needs the live open
 *     pipeline on every read of a forecast; apps/api and apps/crm are separately deployed
 *     services sharing one Postgres with no formal internal API for this query shape yet, and an
 *     HTTP round-trip per forecast read/list call would add material latency to a synchronous path
 *   - Review date: revisit at the next architecture review after apps/crm's internal API surface
 *     covers this query shape (tracked in ADR 0003, Wave 2)
 */

/** Maximum number of historical periods used for uncertainty calculation */
const DEFAULT_HISTORY_PERIODS = 6;
/** Minimum number of observations required for statistical confidence */
const MIN_SAMPLE_SIZE = 2;
/** Maximum allowed amount for validation (100M in base currency) */
const MAX_FORECAST_AMOUNT = 100_000_000;
/** Minimum allowed amount for validation */
const MIN_FORECAST_AMOUNT = 0;

export interface ForecastUncertainty {
  /** Relative sample standard deviation of actual-vs-model error. */
  percentage: number;
  amount: number;
  lowerBound: number;
  upperBound: number;
  sampleSize: number;
  periods: string[];
}

export interface ForecastDataGap {
  dealId: string;
  dealName: string;
  missingFields: Array<"amount" | "closeDate" | "stage">;
}

export interface RevenueForecastRecord {
  id: string;
  workspaceId: string;
  periodLabel: string;
  modelAmount: number;
  currency: string;
  managerAdjustedAmount: number | null;
  managerAdjustedReason: string | null;
  managerAdjustedBy: string | null;
  /** managerAdjustedAmount - modelAmount, when a manager figure exists — the gap the reason explains. */
  managerGapToModel: number | null;
  repCommittedAmount: number | null;
  repCommittedReason: string | null;
  repCommittedBy: string | null;
  /** repCommittedAmount - modelAmount, when a rep figure exists. */
  repGapToModel: number | null;
  uncertainty: ForecastUncertainty | null;
  dataGaps: ForecastDataGap[];
  createdAt: string;
  updatedAt: string;
}

// Validate forecast row data before serialization
function validateForecastRow(row: typeof revenueForecasts.$inferSelect): void {
  if (!row.id || !row.workspaceId || !row.periodLabel) {
    throw new Error("Invalid forecast row: Missing required identifiers (id, workspaceId, periodLabel)");
  }
  if (row.modelAmount == null || Number(row.modelAmount) < 0) {
    throw new Error(`Invalid forecast row ${row.id}: Model amount must be a non-negative number`);
  }
  if (row.managerAdjustedAmount != null && Number(row.managerAdjustedAmount) < 0) {
    throw new Error(`Invalid forecast row ${row.id}: Manager adjusted amount must be non-negative`);
  }
  if (row.repCommittedAmount != null && Number(row.repCommittedAmount) < 0) {
    throw new Error(`Invalid forecast row ${row.id}: Rep committed amount must be non-negative`);
  }
  if (!(row.createdAt instanceof Date) || !(row.updatedAt instanceof Date)) {
    throw new Error(`Invalid forecast row ${row.id}: CreatedAt/UpdatedAt must be valid dates`);
  }
}

function serialize(row: typeof revenueForecasts.$inferSelect): RevenueForecastRecord {
  validateForecastRow(row);
  
  const modelAmount = Number(row.modelAmount);
  const managerAdjustedAmount = row.managerAdjustedAmount != null ? Number(row.managerAdjustedAmount) : null;
  const repCommittedAmount = row.repCommittedAmount != null ? Number(row.repCommittedAmount) : null;
  
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    periodLabel: row.periodLabel,
    modelAmount,
    currency: row.currency,
    managerAdjustedAmount,
    managerAdjustedReason: row.managerAdjustedReason,
    managerAdjustedBy: row.managerAdjustedBy,
    managerGapToModel: managerAdjustedAmount != null ? managerAdjustedAmount - modelAmount : null,
    repCommittedAmount,
    repCommittedReason: row.repCommittedReason,
    repCommittedBy: row.repCommittedBy,
    repGapToModel: repCommittedAmount != null ? repCommittedAmount - modelAmount : null,
    uncertainty: null,
    dataGaps: [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * (Re)computes the model-generated figure for a period from the live rollup's open
 * pipeline value and upserts it — the manager/rep figures (if already set) are left
 * untouched, so recomputing the model number never silently discards human input.
 *
 * @param db Database connection
 * @param config Environment configuration
 * @param workspaceId Workspace identifier
 * @param periodLabel Period in format YYYY-MM or YYYY-Q[1-4]
 * @returns Enriched forecast record with uncertainty and data gaps
 * @throws {HttpError} If period label format is invalid
 */
export async function refreshModelForecast(
  db: Db,
  config: Env,
  workspaceId: string,
  periodLabel: string
): Promise<RevenueForecastRecord> {
  validatePeriodLabel(periodLabel);
  const rollup = await computeCroRollup(db, config, workspaceId);

  const [row] = await db
    .insert(revenueForecasts)
    .values({
      workspaceId,
      periodLabel,
      modelAmount: rollup.pipelineValue.toString(),
      currency: rollup.currency,
    })
    .onConflictDoUpdate({
      target: [revenueForecasts.workspaceId, revenueForecasts.periodLabel],
      set: {
        modelAmount: rollup.pipelineValue.toString(),
        currency: rollup.currency,
        updatedAt: new Date(),
      },
    })
    .returning();
  return (await getForecast(db, workspaceId, periodLabel))!;
}

/**
 * Lists all forecasts for a workspace with computed uncertainty bands and data gaps.
 *
 * @param db Database connection
 * @param workspaceId Workspace identifier
 * @returns Array of enriched forecast records sorted by period (descending)
 */
export async function listForecasts(db: Db, workspaceId: string): Promise<RevenueForecastRecord[]> {
  const rows = await db.select()
    .from(revenueForecasts)
    .where(eq(revenueForecasts.workspaceId, workspaceId));
  return enrichForecasts(db, rows.map(serialize));
}

/**
 * Gets a specific forecast period with computed uncertainty band and data gaps.
 * Loads historical periods to calculate relative uncertainty.
 *
 * @param db Database connection
 * @param workspaceId Workspace identifier
 * @param periodLabel Period in format YYYY-MM or YYYY-Q[1-4]
 * @returns Enriched forecast record or null if not found
 */
export async function getForecast(
  db: Db,
  workspaceId: string,
  periodLabel: string
): Promise<RevenueForecastRecord | null> {
  validatePeriodLabel(periodLabel);
  
  const [row] = await db
    .select()
    .from(revenueForecasts)
    .where(and(eq(revenueForecasts.workspaceId, workspaceId), eq(revenueForecasts.periodLabel, periodLabel)));
  if (!row) return null;

  const history = await db.select().from(revenueForecasts).where(eq(revenueForecasts.workspaceId, workspaceId));
  return (await enrichForecasts(db, history.map(serialize))).find((forecast) => forecast.periodLabel === periodLabel) ?? null;
}

/**
 * Validates period label format (YYYY-MM or YYYY-Q[1-4]).
 * @throws {HttpError} If format is invalid
 * @internal
 */
function validatePeriodLabel(periodLabel: string): void {
  const isValidMonth = /^\d{4}-\d{2}$/.test(periodLabel);
  const isValidQuarter = /^\d{4}-Q[1-4]$/i.test(periodLabel);
  if (!isValidMonth && !isValidQuarter) {
    throw new HttpError("invalid_period_format", 400, {
      message: `Period must be YYYY-MM or YYYY-Q[1-4], got: ${periodLabel}`,
    });
  }
}

/**
 * Validates forecast figure input for amount and reason.
 * @throws {HttpError} If validation fails
 * @internal
 */
function validateForecastInput(input: SetForecastFigureInput): void {
  if (typeof input.amount !== "number" || input.amount < MIN_FORECAST_AMOUNT || input.amount > MAX_FORECAST_AMOUNT) {
    throw new HttpError("invalid_amount", 400, {
      message: `Amount must be between ${MIN_FORECAST_AMOUNT} and ${MAX_FORECAST_AMOUNT}, got: ${input.amount}`,
    });
  }
  const trimmedReason = input.reason?.trim() || "";
  if (trimmedReason.length === 0) {
    throw new HttpError("missing_reason", 400, {
      message: "A driver explanation (reason) is required for any adjustment",
    });
  }
  if (trimmedReason.length > 500) {
    throw new HttpError("reason_too_long", 400, {
      message: "Reason must be 500 characters or less",
    });
  }
}

/**
 * Parses period label into ISO date range for deal close date filtering.
 * @internal
 */
function periodRange(periodLabel: string): { start: string; end: string } | null {
  const month = periodLabel.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    const year = Number(month[1]);
    const monthNumber = Number(month[2]);
    if (monthNumber >= 1 && monthNumber <= 12) {
      const next = new Date(Date.UTC(year, monthNumber, 1));
      return {
        start: `${year}-${month[2]}-01`,
        end: next.toISOString().slice(0, 10),
      };
    }
  }

  const quarter = periodLabel.match(/^(\d{4})-Q([1-4])$/i);
  if (quarter) {
    const year = Number(quarter[1]);
    const startMonth = (Number(quarter[2]) - 1) * 3;
    const start = new Date(Date.UTC(year, startMonth, 1));
    const end = new Date(Date.UTC(year, startMonth + 3, 1));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  return null;
}

/**
 * Computes sample standard deviation for a set of values.
 * Returns null if sample size is less than 2 (insufficient for statistical confidence).
 * Uses Bessel's correction (n-1 denominator) for unbiased sample variance.
 * @internal
 */
function sampleStandardDeviation(values: number[]): number | null {
  if (values.length < MIN_SAMPLE_SIZE) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Enriches forecasts with computed uncertainty bands and data-gap analysis.
 *
 * Uncertainty Band Calculation:
 * - Analyzes forecast errors (actual - predicted) across historical periods
 * - Computes sample standard deviation of relative errors
 * - Bands represent ±1σ (68% confidence interval) around model forecast
 *
 * Data Gap Detection:
 * - Identifies open deals missing critical fields: amount, closeDate, or stage
 * - Used to explain forecast confidence and data quality metrics
 *
 * @internal
 */
async function enrichForecasts(db: Db, forecasts: RevenueForecastRecord[]): Promise<RevenueForecastRecord[]> {
  if (forecasts.length === 0) return [];

  const workspaceId = forecasts[0]!.workspaceId;
  const dealRows = await db
    .select({
      id: deals.id,
      name: deals.name,
      amount: deals.amount,
      closeDate: deals.closeDate,
      status: deals.status,
      stageName: pipelineStages.name,
      isClosedWon: pipelineStages.isClosedWon,
    })
    .from(deals)
    .leftJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
    .where(and(eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)));

  const historical = [...forecasts]
    .sort((left, right) => right.periodLabel.localeCompare(left.periodLabel))
    .slice(0, DEFAULT_HISTORY_PERIODS);
  const actualByPeriod = new Map<string, number>();
  for (const forecast of historical) {
    const range = periodRange(forecast.periodLabel);
    if (!range) continue;
    const actual = dealRows.reduce((sum, deal) => {
      const isWon = deal.status === "won" || deal.isClosedWon === true;
      const closeDate = deal.closeDate ?? "";
      return isWon && closeDate >= range.start && closeDate < range.end ? sum + Number(deal.amount ?? 0) : sum;
    }, 0);
    actualByPeriod.set(forecast.periodLabel, actual);
  }

  return forecasts.map((forecast) => {
    // Safely calculate observations with guards against division by zero and invalid data
        const observations = historical
          .filter((item) => {
            if (item.periodLabel === forecast.periodLabel) return false;
            if (item.modelAmount <= 0) {
              console.warn(`getForecast: Skipping historical period ${item.periodLabel} with invalid modelAmount (${item.modelAmount})`);
              return false;
            }
            if (!actualByPeriod.has(item.periodLabel)) return false;
            return true;
          })
          .map((item) => {
            const actual = actualByPeriod.get(item.periodLabel)!;
            return (actual - item.modelAmount) / item.modelAmount;
          });

        // Only calculate uncertainty if we have enough sample data (minimum 2 observations for valid std dev)
        const deviation = observations.length >= 2 ? sampleStandardDeviation(observations) : null;
        const uncertainty = deviation == null || observations.length < 2
          ? null
          : {
              percentage: deviation,
              amount: forecast.modelAmount * deviation,
              lowerBound: Math.max(0, forecast.modelAmount * (1 - deviation)),
              upperBound: forecast.modelAmount * (1 + deviation),
              sampleSize: observations.length,
              periods: historical
                .filter((item) => item.periodLabel !== forecast.periodLabel && item.modelAmount > 0 && actualByPeriod.has(item.periodLabel))
                .map((item) => item.periodLabel),
            };

    const dataGaps = dealRows
      .filter((deal) => deal.status === "open")
      .map((deal) => {
        const missingFields: ForecastDataGap["missingFields"] = [];
        if (deal.amount == null) missingFields.push("amount");
        if (!deal.closeDate) missingFields.push("closeDate");
        if (!deal.stageName) missingFields.push("stage");
        return missingFields.length > 0 ? { dealId: deal.id, dealName: deal.name, missingFields } : null;
      })
      .filter((gap): gap is ForecastDataGap => gap !== null);

    return { ...forecast, uncertainty, dataGaps };
  });
}

export interface SetForecastFigureInput {
  amount: number;
  reason: string;
  userId?: string;
}

/**
 * Records a manager adjustment to the model forecast for a period.
 * A driver explanation (reason) is required — an adjustment without one cannot explain its own gap.
 *
 * @param db Database connection
 * @param workspaceId Workspace identifier
 * @param periodLabel Period in format YYYY-MM or YYYY-Q[1-4]
 * @param input Manager figure with required reason
 * @returns Enriched forecast record with new manager adjustment
 * @throws {HttpError} If forecast not found (404) or validation fails (400)
 */
export async function setManagerAdjustment(
  db: Db,
  workspaceId: string,
  periodLabel: string,
  input: SetForecastFigureInput
): Promise<RevenueForecastRecord> {
  validatePeriodLabel(periodLabel);
  validateForecastInput(input);
  
  const existing = await getForecast(db, workspaceId, periodLabel);
  if (!existing) throw new HttpError("forecast_not_found", 404, { periodLabel });

  const [row] = await db
    .update(revenueForecasts)
    .set({
      managerAdjustedAmount: input.amount.toString(),
      managerAdjustedReason: input.reason,
      managerAdjustedBy: input.userId ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(revenueForecasts.workspaceId, workspaceId), eq(revenueForecasts.periodLabel, periodLabel)))
    .returning();
  return (await enrichForecasts(db, [serialize(row!)]))[0]!;
}

/**
 * Records a sales rep commitment to the model forecast for a period.
 * A driver explanation (reason) is required — a commitment without one cannot explain its own gap.
 *
 * @param db Database connection
 * @param workspaceId Workspace identifier
 * @param periodLabel Period in format YYYY-MM or YYYY-Q[1-4]
 * @param input Rep commitment with required reason
 * @returns Enriched forecast record with new rep commitment
 * @throws {HttpError} If forecast not found (404) or validation fails (400)
 */
export async function setRepCommitment(
  db: Db,
  workspaceId: string,
  periodLabel: string,
  input: SetForecastFigureInput
): Promise<RevenueForecastRecord> {
  validatePeriodLabel(periodLabel);
  validateForecastInput(input);
  
  const existing = await getForecast(db, workspaceId, periodLabel);
  if (!existing) throw new HttpError("forecast_not_found", 404, { periodLabel });

  const [row] = await db
    .update(revenueForecasts)
    .set({
      repCommittedAmount: input.amount.toString(),
      repCommittedReason: input.reason,
      repCommittedBy: input.userId ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(revenueForecasts.workspaceId, workspaceId), eq(revenueForecasts.periodLabel, periodLabel)))
    .returning();
  return (await enrichForecasts(db, [serialize(row!)]))[0]!;
}