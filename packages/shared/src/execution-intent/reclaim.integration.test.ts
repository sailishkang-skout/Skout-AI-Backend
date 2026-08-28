import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getTestDb } from "./test-db.js";
import { reclaimExpiredLeases } from "./reclaim.js";
import { MAX_ATTEMPTS } from "./retry-policy.js";

const { workspaces, automations, automationVersions, automationRuns, automationRunSteps } = schema;
const dbHandle = await getTestDb();

describe.skipIf(!dbHandle)("reclaimExpiredLeases (real Postgres)", () => {
  // describe.skipIf still runs this factory during test collection (only the individual
  // it() bodies are skipped), so guard the destructure instead of asserting non-null —
  // otherwise a null dbHandle throws a TypeError here instead of skipping cleanly.
  if (!dbHandle) return;
  const { db, sql } = dbHandle;
  let workspaceId: string;
  let automationId: string;
  let versionId: string;
  let runId: string;

  beforeAll(async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: "execution-intent test", slug: `execution-intent-test-${randomUUID()}` })
      .returning();
    workspaceId = workspace!.id;
    const [automation] = await db.insert(automations).values({ workspaceId, name: "test" }).returning();
    automationId = automation!.id;
    const [version] = await db
      .insert(automationVersions)
      .values({ automationId, version: 1, graph: { nodes: [], edges: [] } })
      .returning();
    versionId = version!.id;
    const [run] = await db
      .insert(automationRuns)
      .values({ automationId, automationVersionId: versionId, workspaceId, triggerType: "manual" })
      .returning();
    runId = run!.id;
  });

  afterAll(async () => {
    // Deleting the workspace cascades to automations -> automationVersions -> automationRuns ->
    // automationRunSteps (every FK in this chain is declared onDelete: "cascade").
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  // This suite runs against a real, shared local Postgres that also accumulates leftover rows
  // from other integration test suites in the monorepo. reclaimExpiredLeases has no implicit
  // scoping of its own — that's what its `extraWhere` parameter is for — so every call here
  // scopes to this suite's own runId via extraWhere to stay correct regardless of what else is
  // sitting in the table, and to avoid mutating unrelated rows during a global sweep.
  const ownRun = () => eq(automationRunSteps.automationRunId, runId);

  it("returns an expired claimed row to pending when under the attempt cap", async () => {
    const [step] = await db
      .insert(automationRunSteps)
      .values({
        automationRunId: runId,
        nodeId: "node-reclaim-1",
        status: "claimed",
        idempotencyKey: `${runId}:node-reclaim-1`,
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1000),
        attemptCount: 1,
      })
      .returning();

    const result = await reclaimExpiredLeases(db, automationRunSteps, 100, ownRun());
    expect(result.requeuedIds).toContain(step!.id);
    expect(result.failedIds).not.toContain(step!.id);

    const [row] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.id, step!.id));
    expect(row!.status).toBe("pending");
    expect(row!.leaseOwner).toBeNull();
  });

  it("marks an expired row failed once attemptCount reaches MAX_ATTEMPTS", async () => {
    const [step] = await db
      .insert(automationRunSteps)
      .values({
        automationRunId: runId,
        nodeId: "node-reclaim-2",
        status: "running",
        idempotencyKey: `${runId}:node-reclaim-2`,
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1000),
        attemptCount: MAX_ATTEMPTS,
      })
      .returning();

    const result = await reclaimExpiredLeases(db, automationRunSteps, 100, ownRun());
    expect(result.failedIds).toContain(step!.id);
    expect(result.requeuedIds).not.toContain(step!.id);

    const [row] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.id, step!.id));
    expect(row!.status).toBe("failed");
  });

  it("does not touch a row whose lease has not expired", async () => {
    const [step] = await db
      .insert(automationRunSteps)
      .values({
        automationRunId: runId,
        nodeId: "node-reclaim-3",
        status: "claimed",
        idempotencyKey: `${runId}:node-reclaim-3`,
        leaseOwner: "live-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        attemptCount: 1,
      })
      .returning();

    const result = await reclaimExpiredLeases(db, automationRunSteps, 100, ownRun());
    expect(result.requeuedIds).not.toContain(step!.id);
    expect(result.failedIds).not.toContain(step!.id);

    const [row] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.id, step!.id));
    expect(row!.status).toBe("claimed");
  });

  it("reclaims a claimed row whose lease_expires_at is NULL — NULL is not 'in the future'", async () => {
    // Regression test: `NULL < now()` is NULL (not true) in SQL, so a naive `lt(leaseExpiresAt,
    // now)` predicate would never match a row whose lease was never set, leaving it stuck
    // "claimed" forever. reclaimExpiredLeases must treat a NULL lease as expired too.
    const [step] = await db
      .insert(automationRunSteps)
      .values({
        automationRunId: runId,
        nodeId: "node-reclaim-4",
        status: "claimed",
        idempotencyKey: `${runId}:node-reclaim-4`,
        leaseOwner: "dead-worker",
        leaseExpiresAt: null,
        attemptCount: 1,
      })
      .returning();

    const result = await reclaimExpiredLeases(db, automationRunSteps, 100, ownRun());
    expect(result.requeuedIds).toContain(step!.id);

    const [row] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.id, step!.id));
    expect(row!.status).toBe("pending");
    expect(row!.leaseOwner).toBeNull();
  });

  it("scopes the sweep to extraWhere and leaves rows outside that scope untouched", async () => {
    // A second run's own row, past due — this suite's ownRun()-scoped sweep must not touch it,
    // proving extraWhere actually restricts the sweep rather than just documenting an intent.
    const [otherVersion] = await db
      .insert(automationVersions)
      .values({ automationId, version: 2, graph: { nodes: [], edges: [] } })
      .returning();
    const [otherRun] = await db
      .insert(automationRuns)
      .values({ automationId, automationVersionId: otherVersion!.id, workspaceId, triggerType: "manual" })
      .returning();
    const [otherStep] = await db
      .insert(automationRunSteps)
      .values({
        automationRunId: otherRun!.id,
        nodeId: "node-reclaim-other-run",
        status: "claimed",
        idempotencyKey: `${otherRun!.id}:node-reclaim-other-run`,
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1000),
        attemptCount: 1,
      })
      .returning();

    const result = await reclaimExpiredLeases(db, automationRunSteps, 100, ownRun());
    expect(result.requeuedIds).not.toContain(otherStep!.id);

    const [row] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.id, otherStep!.id));
    expect(row!.status).toBe("claimed"); // untouched by this suite's scoped sweep

    // Clean up directly rather than relying on the outer afterAll's workspace-cascade delete,
    // since this row's run isn't tracked by the shared `runId`.
    await db.delete(automationRuns).where(eq(automationRuns.id, otherRun!.id));
  });
});
