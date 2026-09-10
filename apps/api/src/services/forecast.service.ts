import { desc, eq, gte, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { computeCroRollup } from "./cro-summary.service.js";

/**
 * §7.1 / §5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md (Wave 3).
 *   - Tables touched directly: deals, pipelineStages (owned by apps/crm) — read only
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: §8.15 SS-03's uncertainty band and data-gaps calculations are synchronous reads
 *     off this same service's existing revenueForecasts query — an HTTP round trip into apps/crm
 *     per forecast-detail request for what's a read-only aggregate/scan would add latency with
 *     no benefit, the same rationale as cro-summary.service.ts (already a documented exception)
 *     this file already depends on for its model-forecast figure.
 *   - Review date: revisit once apps/crm's internal API surface covers bulk deal scans (Wave 2,
 *     see ADR 0003).
 */
const { revenueForecasts, deals, pipelineStages } = schema;

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
  createdAt: string;
  updatedAt: string;
}

function serialize(row: typeof revenueForecasts.$inferSelect): RevenueForecastRecord {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * (Re)computes the model-generated figure for a period from the live rollup's open
 * pipeline value and upserts it — the manager/rep figures (if already set) are left
 * untouched, so recomputing the model number never silently discards human input.
 */
export async function refreshModelForecast(
  db: Db,
  config: Env,
  workspaceId: string,
  periodLabel: string
): Promise<RevenueForecastRecord> {
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
  return serialize(row!);
}

export async function listForecasts(db: Db, workspaceId: string): Promise<RevenueForecastRecord[]> {
  const rows = await db.select().from(revenueForecasts).where(scopedTo(revenueForecasts, workspaceId));
  return rows.map(serialize);
}

export async function getForecast(
  db: Db,
  workspaceId: string,
  periodLabel: string
): Promise<RevenueForecastRecord | null> {
  const [row] = await db
    .select()
    .from(revenueForecasts)
    .where(scopedTo(revenueForecasts, workspaceId, eq(revenueForecasts.periodLabel, periodLabel)));
  return row ? serialize(row) : null;
}

/** §8.15 SS-03 — historical variance band around the current model forecast. */
export interface ForecastUncertainty {
  /** Fraction, e.g. 0.12 for "±12%" — the sample standard deviation of past periods' (actual - model) / model. */
  percentage: number;
  /** percentage * the current period's modelAmount, in the forecast's currency. */
  amount: number;
  lowerBound: number;
  upperBound: number;
  sampleSize: number;
  /** Which past periodLabels were actually used (parseable label + a nonzero model amount to compare against). */
  periods: string[];
}

export interface ForecastDataGap {
  dealId: string;
  dealName: string;
  missingFields: ("amount" | "closeDate" | "stage")[];
}

export interface RevenueForecastDetail extends RevenueForecastRecord {
  uncertainty: ForecastUncertainty | null;
  dataGaps: ForecastDataGap[];
}

const UNCERTAINTY_LOOKBACK_PERIODS = 6;
/** Below this, a sample stddev is too noisy to call a "band" — matches the frontend's
 * "Not enough historical periods to calculate variance" fallback for a null uncertainty. */
const MIN_UNCERTAINTY_SAMPLE_SIZE = 2;
const DATA_GAPS_LIMIT = 50;

/**
 * `periodLabel` is documented as "caller-defined, not parsed" (see the schema comment), but the
 * only two shapes ever actually used are "YYYY-MM" and "YYYY-Q[1-4]" — both parsed here into a
 * closed date range so a past period's model figure can be compared against what actually
 * closed in that window. A label in neither shape is skipped (not guessed at), same as the
 * "nonzero model amount" skip below — better to under-sample than compare against a wrong range.
 */
function parsePeriodLabel(label: string): { start: string; end: string } | null {
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(label);
  if (quarterMatch) {
    const year = Number(quarterMatch[1]);
    const quarterStartMonth = (Number(quarterMatch[2]) - 1) * 3;
    const start = new Date(Date.UTC(year, quarterStartMonth, 1));
    const end = new Date(Date.UTC(year, quarterStartMonth + 3, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(label);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]) - 1;
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  return null;
}

/**
 * §8.15 SS-03 — "historical variance between past N periods' actual outcome and that period's
 * model-forecast value." For each of the last `UNCERTAINTY_LOOKBACK_PERIODS` other stored
 * periods (excluding the one being viewed), compares that period's already-stored `modelAmount`
 * against what actually closed-won in its date range, as a relative error. The band is the
 * sample standard deviation of those relative errors applied to the *current* period's model
 * amount — a real statistic over real historical data, not a fabricated placeholder. Returns
 * null (not a fake 0%) when fewer than two comparable periods exist.
 */
export async function computeForecastUncertainty(
  db: Db,
  workspaceId: string,
  currentPeriodLabel: string,
  currentModelAmount: number
): Promise<ForecastUncertainty | null> {
  const priorPeriods = await db
    .select({ periodLabel: revenueForecasts.periodLabel, modelAmount: revenueForecasts.modelAmount })
    .from(revenueForecasts)
    .where(scopedTo(revenueForecasts, workspaceId, ne(revenueForecasts.periodLabel, currentPeriodLabel)))
    .orderBy(desc(revenueForecasts.createdAt))
    .limit(UNCERTAINTY_LOOKBACK_PERIODS);

  const relativeErrors: number[] = [];
  const periodsUsed: string[] = [];
  for (const period of priorPeriods) {
    const range = parsePeriodLabel(period.periodLabel);
    const modelAmount = Number(period.modelAmount);
    if (!range || modelAmount === 0) continue;

    const [actualRow] = await db
      .select({ actual: sql<string | null>`sum(${deals.amount})` })
      .from(deals)
      .where(
        scopedTo(
          deals,
          workspaceId,
          eq(deals.status, "won"),
          isNull(deals.deletedAt),
          gte(deals.closeDate, range.start),
          lte(deals.closeDate, range.end)
        )
      );
    const actualAmount = actualRow?.actual ? Number(actualRow.actual) : 0;
    relativeErrors.push((actualAmount - modelAmount) / modelAmount);
    periodsUsed.push(period.periodLabel);
  }

  if (relativeErrors.length < MIN_UNCERTAINTY_SAMPLE_SIZE) return null;

  const mean = relativeErrors.reduce((sum, e) => sum + e, 0) / relativeErrors.length;
  const variance = relativeErrors.reduce((sum, e) => sum + (e - mean) ** 2, 0) / relativeErrors.length;
  const percentage = Math.round(Math.sqrt(variance) * 1000) / 1000;
  const amount = Math.round(percentage * currentModelAmount);

  return {
    percentage,
    amount,
    lowerBound: Math.round(currentModelAmount - amount),
    upperBound: Math.round(currentModelAmount + amount),
    sampleSize: relativeErrors.length,
    periods: periodsUsed,
  };
}

/**
 * §8.15 SS-03 — "list accounts/deals missing fields the forecast depends on." A deal's `amount`
 * and `closeDate` are plain nullable columns; `stageId` itself is never null (required at
 * creation), so "missing stage" is read instead as "no probability signal at all" — neither an
 * explicit per-deal override nor a nonzero probability on its assigned stage — since that's the
 * actual forecast-relevant thing a null stage would have meant.
 */
export async function computeForecastDataGaps(db: Db, workspaceId: string): Promise<ForecastDataGap[]> {
  const rows = await db
    .select({
      id: deals.id,
      name: deals.name,
      amount: deals.amount,
      closeDate: deals.closeDate,
      probability: deals.probability,
      stageProbability: pipelineStages.probability,
    })
    .from(deals)
    .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
    .where(scopedTo(deals, workspaceId, eq(deals.status, "open"), isNull(deals.deletedAt)))
    .limit(DATA_GAPS_LIMIT);

  const gaps: ForecastDataGap[] = [];
  for (const row of rows) {
    const missingFields: ForecastDataGap["missingFields"] = [];
    if (row.amount == null) missingFields.push("amount");
    if (row.closeDate == null) missingFields.push("closeDate");
    if (row.probability == null && !row.stageProbability) missingFields.push("stage");
    if (missingFields.length > 0) gaps.push({ dealId: row.id, dealName: row.name, missingFields });
  }
  return gaps;
}

/**
 * The GET /forecasts/:periodLabel detail view — `getForecast` plus the two SS-03 additions,
 * kept as a separate function (rather than folded into `getForecast` itself) so the plain
 * existence-check callers (`setManagerAdjustment`/`setRepCommitment`) and `listForecasts` don't
 * pay for a variance calc + deal scan they don't use.
 */
export async function getForecastDetail(
  db: Db,
  workspaceId: string,
  periodLabel: string
): Promise<RevenueForecastDetail | null> {
  const forecast = await getForecast(db, workspaceId, periodLabel);
  if (!forecast) return null;

  const [uncertainty, dataGaps] = await Promise.all([
    computeForecastUncertainty(db, workspaceId, periodLabel, forecast.modelAmount),
    computeForecastDataGaps(db, workspaceId),
  ]);
  return { ...forecast, uncertainty, dataGaps };
}

export interface SetForecastFigureInput {
  amount: number;
  reason: string;
  userId?: string;
}

/** A driver explanation (`reason`) is required — an adjustment without one can't explain its own gap. */
export async function setManagerAdjustment(
  db: Db,
  workspaceId: string,
  periodLabel: string,
  input: SetForecastFigureInput
): Promise<RevenueForecastRecord> {
  const existing = await getForecast(db, workspaceId, periodLabel);
  if (!existing) throw new HttpError("forecast_not_found", 404);

  const [row] = await db
    .update(revenueForecasts)
    .set({
      managerAdjustedAmount: input.amount.toString(),
      managerAdjustedReason: input.reason,
      managerAdjustedBy: input.userId ?? null,
      updatedAt: new Date(),
    })
    .where(scopedTo(revenueForecasts, workspaceId, eq(revenueForecasts.periodLabel, periodLabel)))
    .returning();
  return serialize(row!);
}

export async function setRepCommitment(
  db: Db,
  workspaceId: string,
  periodLabel: string,
  input: SetForecastFigureInput
): Promise<RevenueForecastRecord> {
  const existing = await getForecast(db, workspaceId, periodLabel);
  if (!existing) throw new HttpError("forecast_not_found", 404);

  const [row] = await db
    .update(revenueForecasts)
    .set({
      repCommittedAmount: input.amount.toString(),
      repCommittedReason: input.reason,
      repCommittedBy: input.userId ?? null,
      updatedAt: new Date(),
    })
    .where(scopedTo(revenueForecasts, workspaceId, eq(revenueForecasts.periodLabel, periodLabel)))
    .returning();
  return serialize(row!);
}
