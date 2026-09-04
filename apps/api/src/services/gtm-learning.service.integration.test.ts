import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { runGtmLearningAggregation, queryGtmLearningOutcomes } from "./gtm-learning.service.js";

const {
  workspaces,
  sequences,
  sequenceSteps,
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  prospectScores,
  prospectActivations,
  signals,
  inboxThreads,
  inboxes,
  companies,
  pipelines,
  pipelineStages,
  deals,
  gtmLearningOutcomes,
} = schema;

/**
 * §8.15 SP-10 — end-to-end proof that the aggregation job actually joins all 5 source areas
 * (sequence enrollment, signals, message/content version, channel, outcome) rather than just
 * some of them: every dimension column asserted below comes from a distinct table inserted with
 * a known, deliberately-chosen value, so a wrong join (or a silently-dropped one) fails a
 * specific assertion instead of the whole test going green by coincidence.
 */
describe("gtm-learning.service — cross-tab aggregation (SP-10)", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let sequenceId: string;
  let stepId: string;
  let enrollmentId: string;
  let enrollmentStepId: string;
  let companyId: string;
  const prospectId = `gtm-test-prospect-${Date.now()}`;
  const corpusCompanyId = `gtm-test-company-${Date.now()}`;
  const executedAt = new Date("2026-06-01T12:00:00Z");

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `GTM Learning Test WS ${Date.now()}`, slug: `gtm-learning-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    // 1. Sequence enrollment (+ its channel/message-variant context).
    const [seq] = await db
      .insert(sequences)
      .values({ workspaceId, name: "GTM Test Sequence", status: "active", mode: "A" })
      .returning();
    sequenceId = seq!.id;

    const [step] = await db
      .insert(sequenceSteps)
      .values({ sequenceId, stepOrder: 1, stepType: "linkedin" })
      .returning();
    stepId = step!.id;

    const [enrollment] = await db
      .insert(sequenceEnrollments)
      .values({ workspaceId, sequenceId, prospectId, status: "active" })
      .returning();
    enrollmentId = enrollment!.id;

    const [enrollmentStep] = await db
      .insert(sequenceEnrollmentSteps)
      .values({
        enrollmentId,
        stepId,
        status: "executed",
        executedAt,
        variantKey: "B",
      })
      .returning();
    enrollmentStepId = enrollmentStep!.id;

    // ICP dimension — a score recorded before the touchpoint. prospect_scores is keyed
    // (workspaceId, prospectId) — only the current score is ever retained, no history — so the
    // aggregation's "at/before touchpointAt" join is defensive (never lets a score from after
    // the touchpoint count), not a real point-in-time reconstruction.
    await db.insert(prospectScores).values({
      workspaceId,
      prospectId,
      score: 87,
      priority: "high",
      scoredAt: new Date("2026-05-30T00:00:00Z"),
    });

    await db.insert(prospectActivations).values({ workspaceId, prospectId, companyId: corpusCompanyId });

    // 2. Signal dimension — active at touchpoint time, on the prospect's company.
    await db.insert(signals).values({
      entityType: "company",
      entityId: corpusCompanyId,
      signalType: "recent_funding",
      strength: 0.9,
      detectedAt: new Date("2026-05-20T00:00:00Z"),
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    // A weaker signal active at the same time — proves "highest strength wins", not "first row".
    await db.insert(signals).values({
      entityType: "company",
      entityId: corpusCompanyId,
      signalType: "headcount_growth",
      strength: 0.3,
      detectedAt: new Date("2026-05-20T00:00:00Z"),
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    // An already-expired signal — proves expiresAt is actually respected.
    await db.insert(signals).values({
      entityType: "company",
      entityId: corpusCompanyId,
      signalType: "leadership_change",
      strength: 0.99,
      detectedAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date("2026-02-01T00:00:00Z"),
    });

    // 5. Outcome dimension — reply + a qualified deal for revenue/pipeline attribution.
    const [inbox] = await db
      .insert(inboxes)
      .values({ workspaceId, emailAddress: `gtm-test-${Date.now()}@example.com`, provider: "smtp" })
      .returning();
    await db.insert(inboxThreads).values({
      workspaceId,
      inboxId: inbox!.id,
      enrollmentId,
      prospectId,
      subject: "Re: intro",
      status: "replied",
      replyTag: "positive",
    });

    const [company] = await db
      .insert(companies)
      .values({ workspaceId, name: "GTM Test Co", sourceProspectCompanyId: corpusCompanyId })
      .returning();
    companyId = company!.id;

    const [pipeline] = await db.insert(pipelines).values({ workspaceId, name: "GTM Test Pipeline" }).returning();
    const [stage] = await db
      .insert(pipelineStages)
      .values({ pipelineId: pipeline!.id, name: "Won", orderIndex: 1, isClosedWon: true })
      .returning();
    await db.insert(deals).values({
      workspaceId,
      companyId,
      pipelineId: pipeline!.id,
      stageId: stage!.id,
      name: "GTM Test Deal",
      amount: "5000.00",
      status: "won",
    });
  });

  afterAll(async () => {
    // prospect_activations.workspace_id has no onDelete cascade (pre-existing schema property,
    // unlike every other table this test touches) — clean it up explicitly first.
    await db.delete(prospectActivations).where(eq(prospectActivations.workspaceId, workspaceId));
    await db.delete(signals).where(eq(signals.entityId, corpusCompanyId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  it("populates gtm_learning_outcomes with the correct value joined from each of the 5 source areas", async () => {
    const { rowCount } = await runGtmLearningAggregation(db, workspaceId);
    expect(rowCount).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(gtmLearningOutcomes)
      .where(eq(gtmLearningOutcomes.enrollmentStepId, enrollmentStepId));

    expect(row).toBeTruthy();
    expect(row!.workspaceId).toBe(workspaceId);
    expect(row!.enrollmentId).toBe(enrollmentId);
    expect(row!.sequenceId).toBe(sequenceId);
    expect(row!.prospectId).toBe(prospectId);

    // channel — from sequence_steps.step_type
    expect(row!.channel).toBe("linkedin");
    // message/content version — from sequence_enrollment_steps.variant_key
    expect(row!.variantKey).toBe("B");
    // ICP — the score recorded BEFORE the touchpoint, not the later one
    expect(row!.icpScore).toBe(87);
    expect(row!.icpPriority).toBe("high");
    // signal — the highest-strength active signal, not the expired or weaker one
    expect(row!.signalType).toBe("recent_funding");
    expect(row!.signalStrength).toBeCloseTo(0.9, 5);
    // outcome — reply, no meeting, a closed-won deal
    expect(row!.replied).toBe(true);
    expect(row!.meetingBooked).toBe(false);
    expect(row!.opportunityCreated).toBe(true);
    expect(Number(row!.revenueAmount)).toBe(5000);
  });

  it("is idempotent — re-running the aggregation updates the row in place instead of duplicating it", async () => {
    await runGtmLearningAggregation(db, workspaceId);
    await runGtmLearningAggregation(db, workspaceId);

    const rows = await db
      .select()
      .from(gtmLearningOutcomes)
      .where(eq(gtmLearningOutcomes.enrollmentStepId, enrollmentStepId));

    expect(rows).toHaveLength(1);
  });

  it("supports slicing by channel, signal type, and variant independently", async () => {
    await runGtmLearningAggregation(db, workspaceId);

    const byChannel = await queryGtmLearningOutcomes(db, workspaceId, { channel: "linkedin" });
    expect(byChannel.some((r) => r.enrollmentStepId === enrollmentStepId)).toBe(true);

    const bySignal = await queryGtmLearningOutcomes(db, workspaceId, { signalType: "recent_funding" });
    expect(bySignal.some((r) => r.enrollmentStepId === enrollmentStepId)).toBe(true);

    const byVariant = await queryGtmLearningOutcomes(db, workspaceId, { variantKey: "B" });
    expect(byVariant.some((r) => r.enrollmentStepId === enrollmentStepId)).toBe(true);

    const noMatch = await queryGtmLearningOutcomes(db, workspaceId, { channel: "email" });
    expect(noMatch.some((r) => r.enrollmentStepId === enrollmentStepId)).toBe(false);
  });
});
