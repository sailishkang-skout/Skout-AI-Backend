import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { gtmLearningOutcomes } = schema;

export interface GtmLearningAggregationResult {
  /** Rows inserted or refreshed by this run. */
  rowCount: number;
}

/**
 * §8.15 SP-10 — the GTM-learning cross-tab aggregation. A single INSERT ... SELECT ... ON
 * CONFLICT DO UPDATE joining 5 existing tables (no new instrumentation):
 *
 *  - sequence_enrollment_steps + sequence_steps  -> channel, message variant, touchpoint time
 *  - sequence_enrollments                        -> sequenceId, prospectId
 *  - prospect_scores (latest row at/before the touchpoint) -> ICP score/priority
 *  - signals (active at the touchpoint, on the prospect or its company, highest strength wins)
 *  - inbox_threads (replied/meeting_booked) + companies/deals/pipeline_stages (opportunity,
 *    qualified pipeline, revenue) -> outcome, attributed to the whole enrollment
 *
 * Grain is one row per executed touchpoint (sequence_enrollment_steps.status = 'executed'), not
 * per enrollment — see the table's own doc comment in packages/db/src/schema/reporting.ts for
 * why. Idempotent via the (workspaceId, enrollmentStepId) unique constraint: re-running (the
 * scheduled sweep, or a manual backfill) only refreshes outcome/deal columns that may have
 * changed since the row was first computed — it never duplicates a touchpoint.
 *
 * Raw SQL rather than the query builder: the "latest score at/before this timestamp" and
 * "highest-strength signal active at this timestamp" joins are naturally LATERAL/DISTINCT ON
 * queries, which Drizzle's fluent builder does not express cleanly — and this runs server-side
 * in one round trip instead of N queries per touchpoint.
 */
export async function runGtmLearningAggregation(db: Db, workspaceId?: string): Promise<GtmLearningAggregationResult> {
  const workspaceFilter = workspaceId ? sql`AND es.workspace_id = ${workspaceId}::uuid` : sql``;

  const result = await db.execute(sql`
    INSERT INTO gtm_learning_outcomes (
      workspace_id, enrollment_id, enrollment_step_id, sequence_id, prospect_id,
      touchpoint_at, channel, sequence_version_id, variant_key,
      icp_score, icp_priority, signal_type, signal_strength,
      replied, meeting_booked, opportunity_created, pipeline_amount, revenue_amount, computed_at
    )
    SELECT
      es.workspace_id,
      es.id,
      step.id,
      es.sequence_id,
      es.prospect_id,
      step.executed_at,
      st.step_type,
      es.sequence_version_id,
      step.variant_key,
      score.score,
      score.priority,
      sig.signal_type,
      sig.strength,
      COALESCE(it.replied, false),
      COALESCE(it.meeting_booked, false),
      COALESCE(deal_agg.has_deal, false),
      deal_agg.pipeline_amount,
      deal_agg.revenue_amount,
      now()
    FROM sequence_enrollment_steps step
    JOIN sequence_enrollments es ON es.id = step.enrollment_id
    JOIN sequence_steps st ON st.id = step.step_id
    LEFT JOIN LATERAL (
      SELECT ps.score, ps.priority
      FROM prospect_scores ps
      WHERE ps.workspace_id = es.workspace_id
        AND ps.prospect_id = es.prospect_id
        AND ps.scored_at <= step.executed_at
      ORDER BY ps.scored_at DESC
      LIMIT 1
    ) score ON true
    LEFT JOIN prospect_activations pa
      ON pa.workspace_id = es.workspace_id AND pa.prospect_id = es.prospect_id
    LEFT JOIN LATERAL (
      SELECT sig.signal_type, sig.strength
      FROM signals sig
      WHERE sig.detected_at <= step.executed_at
        AND (sig.expires_at IS NULL OR sig.expires_at > step.executed_at)
        AND (
          (sig.entity_type = 'company' AND pa.company_id IS NOT NULL AND sig.entity_id = pa.company_id)
          OR (sig.entity_type = 'prospect' AND sig.entity_id = es.prospect_id)
        )
      ORDER BY sig.strength DESC NULLS LAST, sig.detected_at DESC
      LIMIT 1
    ) sig ON true
    LEFT JOIN LATERAL (
      SELECT
        bool_or(it2.status IN ('replied', 'meeting_booked', 'closed') OR it2.reply_tag IS NOT NULL) AS replied,
        bool_or(it2.status = 'meeting_booked') AS meeting_booked
      FROM inbox_threads it2
      WHERE it2.enrollment_id = es.id
    ) it ON true
    LEFT JOIN companies co
      ON co.workspace_id = es.workspace_id AND co.source_prospect_company_id = pa.company_id
    LEFT JOIN LATERAL (
      SELECT
        bool_or(true) AS has_deal,
        sum(d.amount) FILTER (WHERE NOT COALESCE(pst.is_closed_lost, false)) AS pipeline_amount,
        sum(d.amount) FILTER (WHERE COALESCE(pst.is_closed_won, false)) AS revenue_amount
      FROM deals d
      JOIN pipeline_stages pst ON pst.id = d.stage_id
      WHERE d.company_id = co.id
    ) deal_agg ON true
    WHERE step.status = 'executed' AND step.executed_at IS NOT NULL
      ${workspaceFilter}
    ON CONFLICT (workspace_id, enrollment_step_id) DO UPDATE SET
      icp_score = excluded.icp_score,
      icp_priority = excluded.icp_priority,
      signal_type = excluded.signal_type,
      signal_strength = excluded.signal_strength,
      replied = excluded.replied,
      meeting_booked = excluded.meeting_booked,
      opportunity_created = excluded.opportunity_created,
      pipeline_amount = excluded.pipeline_amount,
      revenue_amount = excluded.revenue_amount,
      computed_at = excluded.computed_at
  `);

  return { rowCount: result.count ?? 0 };
}

export interface GtmLearningOutcomeFilters {
  channel?: string;
  signalType?: string;
  variantKey?: string;
  sequenceId?: string;
  icpPriority?: string;
}

/** Slices gtm_learning_outcomes by any combination of its dimension columns. */
export async function queryGtmLearningOutcomes(
  db: Db,
  workspaceId: string,
  filters: GtmLearningOutcomeFilters = {},
  limit = 500
) {
  const conditions: SQL[] = [eq(gtmLearningOutcomes.workspaceId, workspaceId)];
  if (filters.channel) conditions.push(eq(gtmLearningOutcomes.channel, filters.channel));
  if (filters.signalType) conditions.push(eq(gtmLearningOutcomes.signalType, filters.signalType));
  if (filters.variantKey) conditions.push(eq(gtmLearningOutcomes.variantKey, filters.variantKey));
  if (filters.sequenceId) conditions.push(eq(gtmLearningOutcomes.sequenceId, filters.sequenceId));
  if (filters.icpPriority) conditions.push(eq(gtmLearningOutcomes.icpPriority, filters.icpPriority));

  return db
    .select()
    .from(gtmLearningOutcomes)
    .where(and(...conditions))
    .orderBy(desc(gtmLearningOutcomes.touchpointAt))
    .limit(Math.min(Math.max(limit, 1), 1000));
}
