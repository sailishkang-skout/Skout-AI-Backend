import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { computeCroRollup } from "./cro-summary.service.js";

const { revenueForecasts } = schema;

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
  const rows = await db.select().from(revenueForecasts).where(eq(revenueForecasts.workspaceId, workspaceId));
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
    .where(and(eq(revenueForecasts.workspaceId, workspaceId), eq(revenueForecasts.periodLabel, periodLabel)));
  return row ? serialize(row) : null;
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
    .where(and(eq(revenueForecasts.workspaceId, workspaceId), eq(revenueForecasts.periodLabel, periodLabel)))
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
    .where(and(eq(revenueForecasts.workspaceId, workspaceId), eq(revenueForecasts.periodLabel, periodLabel)))
    .returning();
  return serialize(row!);
}
