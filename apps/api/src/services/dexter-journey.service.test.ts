import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { proposeDexterPlan, invokeDexterPlan, approveDexterPlan, rejectDexterPlan } from "./dexter-journey.service.js";

const { dexterPlans, workspaces, sequences, sequenceSteps, lists, listMembers } = schema;

describe("dexter-journey.service — actionType extension", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Dexter Journey Test WS ${Date.now()}`, slug: `dexter-journey-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    await sql.end();
  });

  it("proposeDexterPlan without actionType keeps the existing brief-only proposal shape", async () => {
    const { plan } = await proposeDexterPlan(db, { workspaceId, brief: "Just a brief, no action" });
    expect(plan.status).toBe("proposed");
    const proposal = plan.proposal as Record<string, unknown>;
    expect(proposal.actionType).toBeUndefined();
    expect(proposal.hypothesis).toContain("Just a brief");
  });

  it("proposeDexterPlan with actionType/actionParams folds them into proposal", async () => {
    const { plan } = await proposeDexterPlan(db, {
      workspaceId,
      brief: "Enroll regional list into sequence",
      actionType: "enroll_sequence",
      actionParams: { sequenceId: "seq-x", listId: "list-x" },
    });
    const proposal = plan.proposal as Record<string, unknown>;
    expect(proposal.actionType).toBe("enroll_sequence");
    expect(proposal.actionParams).toEqual({ sequenceId: "seq-x", listId: "list-x" });
  });

  it("invokeDexterPlan with no actionType keeps today's canned-outcome stub behavior", async () => {
    const { plan } = await proposeDexterPlan(db, { workspaceId, brief: "Brief only plan" });
    await approveDexterPlan(db, workspaceId, plan.id);
    const { plan: invoked } = await invokeDexterPlan(db, workspaceId, plan.id);
    expect(invoked.status).toBe("invoked");
    expect((invoked.outcome as Record<string, unknown>).invoked).toBe(true);
    expect((invoked.outcome as Record<string, unknown>).learningHint).toBe("threshold_unchanged");
  });

  it("invokeDexterPlan with actionType enroll_sequence calls the real adapter and persists its result", async () => {
    const [seq] = await db
      .insert(sequences)
      .values({ workspaceId, name: "Orchestrator Test Sequence", status: "active", mode: "A" })
      .returning();
    await db.insert(sequenceSteps).values({ sequenceId: seq!.id, stepOrder: 1, stepType: "email" });
    const prospectId = `test-prospect-${Date.now()}`;
    const [list] = await db.insert(lists).values({ workspaceId, name: "Orchestrator Test List" }).returning();
    await db.insert(listMembers).values({ listId: list!.id, prospectId });

    const { plan } = await proposeDexterPlan(db, {
      workspaceId,
      brief: "Enroll test list into test sequence",
      actionType: "enroll_sequence",
      actionParams: { sequenceId: seq!.id, listId: list!.id },
    });
    await approveDexterPlan(db, workspaceId, plan.id);
    const { plan: invoked } = await invokeDexterPlan(db, workspaceId, plan.id);

    expect(invoked.status).toBe("invoked");
    const outcome = invoked.outcome as Record<string, unknown>;
    expect(outcome.enrolled).toBe(1);
    expect(outcome.skipped).toBe(0);
  });

  it("invokeDexterPlan moves to status failed (not left dangling at approved) when the adapter throws", async () => {
    const { plan } = await proposeDexterPlan(db, {
      workspaceId,
      brief: "Enroll into a sequence that doesn't exist",
      actionType: "enroll_sequence",
      actionParams: { sequenceId: "00000000-0000-0000-0000-000000000000", listId: "00000000-0000-0000-0000-000000000000" },
    });
    await approveDexterPlan(db, workspaceId, plan.id);
    const { plan: invoked } = await invokeDexterPlan(db, workspaceId, plan.id);

    expect(invoked.status).toBe("failed");
    expect((invoked.outcome as Record<string, unknown>).error).toBeTruthy();
  });

  it("rejectDexterPlan sets status to rejected from proposed, and rejects an invalid transition", async () => {
    const { plan } = await proposeDexterPlan(db, { workspaceId, brief: "Plan to be rejected" });
    const rejected = await rejectDexterPlan(db, workspaceId, plan.id);
    expect(rejected.status).toBe("rejected");

    await expect(rejectDexterPlan(db, workspaceId, plan.id)).rejects.toMatchObject({ statusCode: 422 });
  });
});
