import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { getTestDb } from "./test-db.js";
import { claimNext } from "./claim.js";
import { renewLease, withLeaseHeartbeat } from "./heartbeat.js";

const { workspaces, automations, automationVersions, automationRuns, automationRunSteps } = schema;
const dbHandle = await getTestDb();

describe.skipIf(!dbHandle)("heartbeat (real Postgres)", () => {
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
  // from other integration test suites in the monorepo. claimNext deliberately claims the oldest
  // pending row *globally* with no implicit scoping — that's what its `extraWhere` parameter is
  // for — so every call here scopes to this suite's own runId via extraWhere to stay correct
  // regardless of what else is sitting in the table.
  const ownRun = () => eq(automationRunSteps.automationRunId, runId);

  it("renewLease extends leaseExpiresAt for the current owner", async () => {
    await db
      .insert(automationRunSteps)
      .values({ automationRunId: runId, nodeId: "node-hb-1", status: "pending", idempotencyKey: `${runId}:node-hb-1` });
    const claimed = await claimNext(db, automationRunSteps, "worker-hb", 60_000, ownRun());
    const originalExpiry = claimed!.leaseExpiresAt!.getTime();

    await new Promise((r) => setTimeout(r, 10));
    const renewed = await renewLease(db, automationRunSteps, claimed!.id, "worker-hb", 60_000);
    expect(renewed).toBe(true);

    const [row] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.id, claimed!.id));
    expect(row!.leaseExpiresAt!.getTime()).toBeGreaterThan(originalExpiry);
  });

  it("renewLease returns false for a worker that does not own the lease", async () => {
    await db
      .insert(automationRunSteps)
      .values({ automationRunId: runId, nodeId: "node-hb-2", status: "pending", idempotencyKey: `${runId}:node-hb-2` });
    const claimed = await claimNext(db, automationRunSteps, "worker-owner", 60_000, ownRun());

    const renewed = await renewLease(db, automationRunSteps, claimed!.id, "worker-imposter", 60_000);
    expect(renewed).toBe(false);
  });

  // SKIPPED — see task-5-report.md "Escalation" section. Confirmed by a bounded diagnostic
  // (not just this test) that in this repo/environment, ANY real Postgres query made while
  // vi.useFakeTimers() is active hangs indefinitely — reproduced with a bare `await renewLease(...)`
  // and no setInterval/advanceTimersByTimeAsync involved at all, so this is not specific to
  // withLeaseHeartbeat's implementation. The only other vi.useFakeTimers() usage in this monorepo
  // (apps/crm/src/services/tasks.service.test.ts) pairs it exclusively with a fully mocked `db`
  // object, never a real connection — there is no established pattern here for combining fake
  // timers with real DB I/O. This is flagged in the task brief as an explicit escalation trigger;
  // left skipped pending a controller decision on how withLeaseHeartbeat's interval behavior
  // should be tested (e.g. a mocked db for this one test, or real timers + a short real interval).
  it.skip("withLeaseHeartbeat renews on an interval while work is in progress", async () => {
    vi.useFakeTimers();
    try {
      await db
        .insert(automationRunSteps)
        .values({ automationRunId: runId, nodeId: "node-hb-3", status: "pending", idempotencyKey: `${runId}:node-hb-3` });
      const claimed = await claimNext(db, automationRunSteps, "worker-hb-3", 60_000, ownRun());

      const workPromise = withLeaseHeartbeat(db, automationRunSteps, claimed!.id, "worker-hb-3", 60_000, async () => {
        await vi.advanceTimersByTimeAsync(25_000); // > 20s heartbeat interval, well under 60s lease
        return "done";
      });
      const result = await workPromise;
      expect(result).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});
