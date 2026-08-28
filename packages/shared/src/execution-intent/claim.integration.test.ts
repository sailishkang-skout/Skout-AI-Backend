import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getTestDb } from "./test-db.js";
import { claimNext } from "./claim.js";

const { workspaces, automations, automationVersions, automationRuns, automationRunSteps } = schema;
const dbHandle = await getTestDb();

describe.skipIf(!dbHandle)("claimNext (real Postgres)", () => {
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
  // from other integration test suites in the monorepo (other automation_run_steps rows with
  // status "pending" from unrelated runs persist across sessions). claimNext deliberately claims
  // the oldest pending row *globally* with no implicit scoping — that's what its `extraWhere`
  // parameter is for — so every call here scopes to this suite's own runId via extraWhere to stay
  // correct regardless of what else is sitting in the table.
  const ownRun = () => eq(automationRunSteps.automationRunId, runId);

  it("claims a pending row and sets lease owner/expiry/attempt count", async () => {
    const [step] = await db
      .insert(automationRunSteps)
      .values({ automationRunId: runId, nodeId: "node-claim-1", status: "pending", idempotencyKey: `${runId}:node-claim-1` })
      .returning();

    const claimed = await claimNext(db, automationRunSteps, "worker-1", 60_000, ownRun());

    expect(claimed?.id).toBe(step!.id);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.leaseOwner).toBe("worker-1");
    expect(claimed?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(claimed?.attemptCount).toBe(1);
  });

  it("returns undefined when nothing is pending", async () => {
    const claimed = await claimNext(db, automationRunSteps, "worker-2", 60_000, ownRun());
    expect(claimed).toBeUndefined();
  });

  it("never lets two concurrent callers claim the same row", async () => {
    await db
      .insert(automationRunSteps)
      .values({ automationRunId: runId, nodeId: "node-claim-race", status: "pending", idempotencyKey: `${runId}:node-claim-race` });

    const [a, b] = await Promise.all([
      claimNext(db, automationRunSteps, "worker-a", 60_000, ownRun()),
      claimNext(db, automationRunSteps, "worker-b", 60_000, ownRun()),
    ]);

    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
  });
});
