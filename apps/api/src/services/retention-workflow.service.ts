import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { computeSignalStackScore, listSignalsForEntity, recordSignal } from "./signal.service.js";
import type { Env } from "../config/env.js";

const { activities, companies, signals } = schema;

/**
 * §7.1/§5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md for the full policy and the other confirmed instances.
 *   - Tables read directly: companies, activities (both owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has read-only access via the shared Postgres instance;
 *     this file only reads these tables — writes go to apps/api-owned signals)
 *   - Reason: the retention sweep is a BullMQ worker job that scans every active/customer company
 *     in a workspace and its recent activity history to detect disengagement, renewal-risk, and
 *     expansion signals; apps/api and apps/crm are separately deployed services sharing one
 *     Postgres with no formal internal API for this bulk query shape yet, and per-company HTTP
 *     round-trips would add material latency and load to a batch job that already fans out
 *     per-company queries
 *   - Review date: revisit at the next architecture review after apps/crm's internal API surface
 *     covers this query shape (tracked in ADR 0003, Wave 2)
 */

export const RETENTION_SIGNAL_TYPES = [
  "retention_disengagement",
  "retention_renewal_risk",
  "retention_expansion",
] as const;

const POSITIVE_ACTIVITY_TYPES = new Set([
  "reply",
  "email_reply",
  "inbound_reply",
  "meeting",
  "meeting_completed",
  "call_connected",
]);
const EXPANSION_SIGNAL_TYPES = new Set(["recent_hiring", "recent_funding"]);

export interface RetentionEvaluationInput {
  now: Date;
  lastActivityAt: Date | null;
  contractEndDate: Date | null;
  latestPositiveSignalAt: Date | null;
  latestExpansionSignalAt: Date | null;
  inactivityDays: number;
  renewalWindowDays: number;
  positiveSignalDays: number;
  expansionSignalDays: number;
  expansionScore: number;
}

export interface RetentionFlag {
  signalType: (typeof RETENTION_SIGNAL_TYPES)[number];
  reason: string;
  sourceAt: Date | null;
  score?: number;
}

// Validate input parameters to prevent invalid calculations
function validateRetentionInput(input: RetentionEvaluationInput): void {
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error("Invalid 'now' date provided to retention evaluation");
  }
  if (input.inactivityDays < 1 || input.positiveSignalDays < 1 || input.expansionSignalDays < 1 || input.renewalWindowDays < 1) {
    throw new Error("All day thresholds must be positive integers");
  }
  if (input.expansionScore < 0) {
    throw new Error("Expansion score cannot be negative");
  }
  // Validate optional dates if provided
  const dateFields = [input.lastActivityAt, input.contractEndDate, input.latestPositiveSignalAt, input.latestExpansionSignalAt];
  for (const date of dateFields) {
    if (date && (!(date instanceof Date) || Number.isNaN(date.getTime()))) {
      throw new Error("Invalid date field provided to retention evaluation");
    }
  }
}

export function evaluateRetentionFlags(input: RetentionEvaluationInput): RetentionFlag[] {
  // Validate input first to catch errors early
  validateRetentionInput(input);
  
  const flags: RetentionFlag[] = [];
  const inactivityCutoff = input.now.getTime() - input.inactivityDays * 86_400_000;
  const positiveCutoff = input.now.getTime() - input.positiveSignalDays * 86_400_000;
  const expansionCutoff = input.now.getTime() - input.expansionSignalDays * 86_400_000;
  const renewalCutoff = input.now.getTime() + input.renewalWindowDays * 86_400_000;

  if (!input.lastActivityAt || input.lastActivityAt.getTime() < inactivityCutoff) {
    flags.push({
      signalType: "retention_disengagement",
      reason: `No account activity in the last ${input.inactivityDays} days.`,
      sourceAt: input.lastActivityAt,
    });
  }

  if (
    input.contractEndDate &&
    input.contractEndDate.getTime() >= input.now.getTime() &&
    input.contractEndDate.getTime() <= renewalCutoff &&
    (!input.latestPositiveSignalAt || input.latestPositiveSignalAt.getTime() < positiveCutoff)
  ) {
    flags.push({
      signalType: "retention_renewal_risk",
      reason: `Contract ends within ${input.renewalWindowDays} days with no positive account signal in the last ${input.positiveSignalDays} days.`,
      sourceAt: input.contractEndDate,
    });
  }

  if (input.latestExpansionSignalAt && input.latestExpansionSignalAt.getTime() >= expansionCutoff && input.expansionScore > 0) {
    flags.push({
      signalType: "retention_expansion",
      reason: `New hiring or funding signal detected in the last ${input.expansionSignalDays} days.`,
      sourceAt: input.latestExpansionSignalAt,
      score: input.expansionScore,
    });
  }

  return flags;
}

function parseDate(value: string | Date | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function companySignalIds(company: { id: string; sourceProspectCompanyId: string | null }): string[] {
  return Array.from(new Set([company.id, company.sourceProspectCompanyId].filter((id): id is string => Boolean(id))));
}

export async function sweepWorkspaceForRetention(db: Db, config: Env, workspaceId: string): Promise<number> {
  const now = new Date();
  let processedCount = 0;
  
  if (!workspaceId) {
    console.error("sweepWorkspaceForRetention: Missing workspaceId, aborting sweep");
    return 0;
  }
  
  try {
    const companiesToCheck = await db
      .select({
        id: companies.id,
        sourceProspectCompanyId: companies.sourceProspectCompanyId,
      name: companies.name,
      contractEndDate: companies.contractEndDate,
    })
    .from(companies)
    .where(
      and(
        eq(companies.workspaceId, workspaceId),
        inArray(companies.status, ["active", "customer"]),
        isNull(companies.deletedAt)
      )
    );

    let flagged = 0;
    for (const company of companiesToCheck) {
      // Process each company independently to avoid single failure breaking entire sweep
      try {
        const lastActivity = await db
          .select({ occurredAt: activities.occurredAt })
          .from(activities)
          .where(and(eq(activities.workspaceId, workspaceId), eq(activities.entityType, "company"), eq(activities.entityId, company.id)))
          .orderBy(desc(activities.occurredAt))
          .limit(1);

        const positiveActivity = await db
          .select({ occurredAt: activities.occurredAt })
          .from(activities)
          .where(
            and(
              eq(activities.workspaceId, workspaceId),
              eq(activities.entityType, "company"),
              eq(activities.entityId, company.id),
              inArray(activities.activityType, Array.from(POSITIVE_ACTIVITY_TYPES))
            )
          )
          .orderBy(desc(activities.occurredAt))
          .limit(1);

        const signalRows = (await Promise.all(
          companySignalIds(company).map((entityId) => listSignalsForEntity(db, entityId, { entityType: "company" }))
        )).flat();
        const expansionSignals = signalRows.filter(
          (signal) => EXPANSION_SIGNAL_TYPES.has(signal.signalType) && signal.observedAt
        );
        const latestExpansionSignal = expansionSignals
          .slice()
          .sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime())
          .at(-1) ?? null;
        const expansionScore = computeSignalStackScore(expansionSignals, { now }).score;
        const latestPositiveSignalAt = positiveActivity[0]?.occurredAt ?? null;
        const flags = evaluateRetentionFlags({
          now,
          lastActivityAt: lastActivity[0]?.occurredAt ?? null,
          contractEndDate: parseDate(company.contractEndDate),
          latestPositiveSignalAt,
          latestExpansionSignalAt: latestExpansionSignal ? parseDate(latestExpansionSignal.observedAt) : null,
          inactivityDays: config.RETENTION_DISENGAGEMENT_DAYS,
          renewalWindowDays: config.RETENTION_RENEWAL_WINDOW_DAYS,
          positiveSignalDays: config.RETENTION_POSITIVE_SIGNAL_DAYS,
          expansionSignalDays: config.RETENTION_EXPANSION_SIGNAL_DAYS,
          expansionScore,
        });

        for (const flag of flags) {
          const existingConditions = [
            eq(signals.entityType, "company"),
            eq(signals.entityId, company.id),
            eq(signals.signalType, flag.signalType),
            flag.sourceAt
              ? eq(signals.observedAt, flag.sourceAt)
              : gte(signals.detectedAt, new Date(now.getTime() - config.RETENTION_SWEEP_INTERVAL_HOURS * 3_600_000)),
          ];
          const existing = await db
            .select({ id: signals.id })
            .from(signals)
            .where(and(...existingConditions))
            .limit(1);
          if (existing.length > 0) continue;

          await recordSignal(db, {
            entityType: "company",
            entityId: company.id,
            signalType: flag.signalType,
            reason: `${company.name}: ${flag.reason}`,
            score: flag.score,
            source: "retention-sweep",
            observedAt: flag.sourceAt ?? now,
            detectedAt: now,
          });
          flagged++;
          console.debug(`sweepWorkspaceForRetention: Created ${flag.signalType} signal for company ${company.id} (${company.name})`);
        }
        processedCount++;
      } catch (companyErr) {
        console.error(`sweepWorkspaceForRetention: Failed to process company ${company.id} (${company.name}):`, companyErr);
        continue; // Continue processing other companies even if one fails
      }
    }

    console.info(`sweepWorkspaceForRetention: Completed sweep for workspace ${workspaceId}, processed ${processedCount} companies, created ${flagged} retention signals`);
    return flagged;
  } catch (globalErr) {
    console.error(`sweepWorkspaceForRetention: Fatal error during sweep for workspace ${workspaceId}:`, globalErr);
    return 0;
  }
}