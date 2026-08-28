import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getTestDb } from "./test-db.js";
import { claimNext } from "./claim.js";
import { recordResult, LeaseLostError } from "./record-result.js";

const { workspaces, automations, automationVersions, automationRuns, automationRunSteps } = schema;
const dbHandle = await getTestDb();

describe.skipIf(!dbHandle)("recordResult (real Postgres)", () => {
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

  it("transitions a claimed row to succeeded and releases the lease", async () => {
    await db
      .insert(automationRunSteps)
      .values({ automationRunId: runId, nodeId: "node-rr-1", status: "pending", idempotencyKey: `${runId}:node-rr-1` });
    const claimed = await claimNext(db, automationRunSteps, "worker-rr-1", 60_000);

    const result = await recordResult(db, automationRunSteps, claimed!.id, "worker-rr-1", {
      status: "succeeded",
      output: { ok: true },
    });

    expect(result.status).toBe("succeeded");
    expect(result.leaseOwner).toBeNull();
    expect(result.leaseExpiresAt).toBeNull();
    expect(result.output).toEqual({ ok: true });
  });

  it("throws LeaseLostError when the caller no longer holds the lease", async () => {
    await db
      .insert(automationRunSteps)
      .values({ automationRunId: runId, nodeId: "node-rr-2", status: "pending", idempotencyKey: `${runId}:node-rr-2` });
    const claimed = await claimNext(db, automationRunSteps, "worker-rr-2", 60_000);

    await expect(
      recordResult(db, automationRunSteps, claimed!.id, "someone-else", { status: "succeeded" })
    ).rejects.toThrow(LeaseLostError);
  });

  it("sets outcome_unknown without treating it as retryable-in-place", async () => {
    await db
      .insert(automationRunSteps)
      .values({ automationRunId: runId, nodeId: "node-rr-3", status: "pending", idempotencyKey: `${runId}:node-rr-3` });
    const claimed = await claimNext(db, automationRunSteps, "worker-rr-3", 60_000);

    const result = await recordResult(db, automationRunSteps, claimed!.id, "worker-rr-3", {
      status: "outcome_unknown",
      error: "request timed out with no confirmation",
    });

    expect(result.status).toBe("outcome_unknown");
  });
});
