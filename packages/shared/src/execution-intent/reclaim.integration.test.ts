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

    const result = await reclaimExpiredLeases(db, automationRunSteps);
    expect(result.requeued).toBeGreaterThanOrEqual(1);

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

    await reclaimExpiredLeases(db, automationRunSteps);

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

    await reclaimExpiredLeases(db, automationRunSteps);

    const [row] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.id, step!.id));
    expect(row!.status).toBe("claimed");
  });
});
