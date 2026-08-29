import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { createEvent } from "@skout/shared";
import { loadEnv } from "../config/env.js";
import { upsertActionMode } from "../services/policy-gateway.service.js";
import { rejectDexterPlan } from "../services/dexter-journey.service.js";
import { handleDexterEvent } from "./dexter-orchestrator.worker.js";

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

    const rejected = await rejectDexterPlan(db, workspaceId, plan!.id);
    expect(rejected.status).toBe("rejected");
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
});
