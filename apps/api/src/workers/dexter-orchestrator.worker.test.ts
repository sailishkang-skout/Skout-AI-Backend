import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { createEvent } from "@skout/shared";
import { loadEnv } from "../config/env.js";
import { upsertActionMode } from "../services/policy-gateway.service.js";
import { rejectDexterPlan } from "../services/dexter-journey.service.js";

// Real behavior by default (resolves immediately, like emitSkoutEvent normally does once
// enqueued). The one test below that needs to control timing overrides this for a single call
// via mockImplementationOnce, instead of relying on Redis being unreachable to create a delay.
const enqueueDexterEventJob = vi.fn().mockResolvedValue(undefined);
vi.mock("./dexter-event.queue.js", () => ({
  enqueueDexterEventJob: (...args: unknown[]) => enqueueDexterEventJob(...args),
}));

const { handleDexterEvent } = await import("./dexter-orchestrator.worker.js");

const { dexterPlans, dexterTriggers, workspaces, sequences, sequenceSteps, lists, listMembers, automationPolicies } = schema;

describe("handleDexterEvent", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let sequenceId: string;
  let listId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Dexter Worker Test WS ${Date.now()}`, slug: `dexter-worker-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [seq] = await db
      .insert(sequences)
      .values({ workspaceId, name: "Worker Test Sequence", status: "active", mode: "A" })
      .returning();
    sequenceId = seq!.id;
    await db.insert(sequenceSteps).values({ sequenceId, stepOrder: 1, stepType: "email" });
    const prospectId = `worker-test-prospect-${Date.now()}`;
    const [list] = await db.insert(lists).values({ workspaceId, name: "Worker Test List" }).returning();
    listId = list!.id;
    await db.insert(listMembers).values({ listId, prospectId });

    await db.insert(dexterTriggers).values({
      workspaceId,
      eventType: "regional_brief.approved",
      actionType: "enroll_sequence",
      actionParams: { sequenceId, listId },
      enabled: true,
    });
  });

  afterAll(async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    await db.delete(dexterTriggers).where(eq(dexterTriggers.workspaceId, workspaceId));
    await db.delete(automationPolicies).where(eq(automationPolicies.workspaceId, workspaceId));
    await sql.end();
  });

  it("mode=auto: proposes and immediately auto-invokes the matched trigger", async () => {
    await upsertActionMode(db, workspaceId, "dexter.plan_invoke", "auto");
    const event = createEvent({
      type: "regional_brief.approved",
      tenantId: workspaceId,
      aggregateId: workspaceId,
      data: { versionId: "v-1", slotId: "slot-1" },
    });

    await handleDexterEvent(db, config, event);

    const [plan] = await db.select().from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId)).limit(1);
    expect(plan!.status).toBe("invoked");
    expect((plan!.outcome as Record<string, unknown>).enrolled).toBe(1);
  });

  it("mode=ask (default): proposes but leaves the plan pending for a human", async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    await db.delete(automationPolicies).where(eq(automationPolicies.workspaceId, workspaceId));

    const event = createEvent({
      type: "regional_brief.approved",
      tenantId: workspaceId,
      aggregateId: workspaceId,
      data: { versionId: "v-2", slotId: "slot-2" },
    });

    await handleDexterEvent(db, config, event);

    const [plan] = await db.select().from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId)).limit(1);
    expect(plan!.status).toBe("proposed");
  });

  it("mode=ask: a human can reject the auto-proposed plan via rejectDexterPlan", async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    await db.delete(automationPolicies).where(eq(automationPolicies.workspaceId, workspaceId));

    const event = createEvent({
      type: "regional_brief.approved",
      tenantId: workspaceId,
      aggregateId: workspaceId,
      data: { versionId: "v-3", slotId: "slot-3" },
    });
    await handleDexterEvent(db, config, event);

    const [plan] = await db.select().from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId)).limit(1);
    expect(plan!.status).toBe("proposed");

    const rejected = await rejectDexterPlan(db, config, workspaceId, plan!.id);
    expect(rejected.status).toBe("rejected");
  });

  it("SS-08: signal.high_strength is triggerable — a matching trigger proposes+auto-invokes just like regional_brief.approved", async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    await upsertActionMode(db, workspaceId, "dexter.plan_invoke", "auto");
    const [signalTrigger] = await db
      .insert(dexterTriggers)
      .values({
        workspaceId,
        eventType: "signal.high_strength",
        actionType: "enroll_sequence",
        actionParams: { sequenceId, listId },
        enabled: true,
      })
      .returning();

    const event = createEvent({
      type: "signal.high_strength",
      tenantId: workspaceId,
      aggregateId: "sig-1",
      data: { signalId: "sig-1", signalType: "leadership_change", entityType: "company", entityId: "company-1", strength: 0.8 },
    });

    await handleDexterEvent(db, config, event);

    const [plan] = await db.select().from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId)).limit(1);
    expect(plan!.status).toBe("invoked");
    // The list's one member was already enrolled by an earlier test in this suite — "skipped"
    // (already-enrolled), not "enrolled", is the correct outcome, and still proves invoke ran.
    expect((plan!.outcome as Record<string, unknown>).total).toBe(1);

    await db.delete(dexterTriggers).where(eq(dexterTriggers.id, signalTrigger!.id));
    await db.delete(automationPolicies).where(eq(automationPolicies.workspaceId, workspaceId));
  });

  it("no matching trigger: does nothing", async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    const event = createEvent({
      type: "tam.approved",
      tenantId: workspaceId,
      aggregateId: workspaceId,
      data: {},
    });

    await handleDexterEvent(db, config, event);

    const rows = await db.select().from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("does not process the orchestrator's own dexter.* events, even if a trigger row happens to match (self-amplification guard)", async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    await db.insert(dexterTriggers).values({
      workspaceId,
      eventType: "dexter.plan.proposed",
      actionType: "enroll_sequence",
      actionParams: { sequenceId, listId },
      enabled: true,
    });

    const event = createEvent({
      type: "dexter.plan.proposed",
      tenantId: workspaceId,
      aggregateId: workspaceId,
      data: { planId: "some-plan-id", actionType: null },
    });

    await handleDexterEvent(db, config, event);

    const rows = await db.select().from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);

    await db.delete(dexterTriggers).where(eq(dexterTriggers.eventType, "dexter.plan.proposed"));
  });

  it("mode=auto: a trigger whose invoke is denied by the Policy Gateway (mode changed after propose) lands its plan on failed, not left dangling at approved — and a second trigger on the same event still gets processed", async () => {
    await db.delete(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    await upsertActionMode(db, workspaceId, "dexter.plan_invoke", "auto");

    // A second trigger on the same event type, so we can prove trigger 1's failure
    // doesn't prevent trigger 2 from being processed in the same handleDexterEvent call.
    const [secondTrigger] = await db
      .insert(dexterTriggers)
      .values({
        workspaceId,
        eventType: "regional_brief.approved",
        actionType: "enroll_sequence",
        actionParams: { sequenceId, listId },
        enabled: true,
      })
      .returning();

    const event = createEvent({
      type: "regional_brief.approved",
      tenantId: workspaceId,
      aggregateId: workspaceId,
      data: { versionId: "v-4", slotId: "slot-4" },
    });

    // Deterministically reproduce the propose-time-vs-invoke-time policy race instead of
    // relying on Redis being unreachable (which used to make proposeDexterPlan's event-queue
    // emit block for ~2s incidentally, giving the concurrent mode flip below time to land —
    // that stopped working once Redis became reachable in dev, since the emit then resolves
    // near-instantly and the race window disappears). Here we hold trigger 1's very first
    // emitted event open until the mode flip has actually landed in the DB, then release it,
    // so assertAllowed's invoke-time re-classification is guaranteed to see "ask", not "auto" —
    // reproducing the finding: assertAllowed re-classifies at invoke time and denies once mode
    // is no longer "auto". Because the mode flips to "ask" and stays there, trigger 2 also won't
    // get auto-invoked (its propose sees mode "ask"), but it must still be *processed* (a plan
    // proposed) rather than skipped because trigger 1 threw.
    let releaseFirstEmit!: () => void;
    const firstEmitHeld = new Promise<void>((resolve) => {
      releaseFirstEmit = resolve;
    });
    enqueueDexterEventJob.mockImplementationOnce(async () => {
      await firstEmitHeld;
    });

    const handlePromise = handleDexterEvent(db, config, event);
    await upsertActionMode(db, workspaceId, "dexter.plan_invoke", "ask");
    releaseFirstEmit();
    await handlePromise;

    await db.delete(dexterTriggers).where(eq(dexterTriggers.id, secondTrigger!.id));

    const plans = await db.select().from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));
    expect(plans).toHaveLength(2);

    const failedPlan = plans.find((p) => p.status === "failed");
    expect(failedPlan).toBeTruthy();
    expect((failedPlan!.outcome as Record<string, unknown>).error).toBeTruthy();

    // trigger 2 was still processed (a plan exists for it) instead of being skipped
    // because trigger 1's exception propagated out of the loop.
    const secondPlan = plans.find((p) => p.brief.includes(secondTrigger!.id));
    expect(secondPlan).toBeTruthy();
  });
});
