import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import type { Db } from "@skout/db";
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
});

// `withLeaseHeartbeat`'s interval-scheduling/cleanup behavior is tested here against a mocked
// `db`, not the real Postgres connection above. Fake timers (`vi.useFakeTimers()`) and real
// Postgres I/O don't mix in this repo/environment — a bounded diagnostic confirmed that ANY real
// query made while fake timers are active hangs indefinitely (the `postgres` driver relies on
// real setTimeout/setImmediate internally, which fake timers intercept and never fire). See
// task-5-report.md "Escalation" section for the full investigation. `renewLease`'s real DB
// semantics (ownership check, expiry check, actual UPDATE) are already fully proven by the two
// tests above; what's left here is purely "does withLeaseHeartbeat call renewLease at roughly the
// right cadence, and does it clean up its interval" — a scheduling/lifecycle concern, not a
// database concern, so mocking `db` is the correct isolation, not a workaround. This also means
// this suite doesn't need to be gated behind `dbHandle` at all.
describe("withLeaseHeartbeat (mocked db)", () => {
  it("renews on an interval while work is in progress, and stops renewing once work completes", async () => {
    vi.useFakeTimers();
    try {
      const updateMock = vi.fn(() => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: "some-id" }]),
          }),
        }),
      }));
      const mockDb = { update: updateMock } as unknown as Db;

      const result = await withLeaseHeartbeat(
        mockDb,
        automationRunSteps,
        "some-id",
        "worker-x",
        60_000,
        async () => {
          // > one 20s heartbeat interval (60_000 / 3), well under the 60s lease.
          await vi.advanceTimersByTimeAsync(45_000);
          return "done";
        }
      );

      expect(result).toBe("done");
      expect(updateMock).toHaveBeenCalled();
      const callsWhileWorking = updateMock.mock.calls.length;

      // Advance well past another interval; the timer must have been cleared in withLeaseHeartbeat's
      // `finally` block once work() resolved, so no further renewals should fire.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updateMock.mock.calls.length).toBe(callsWhileWorking);
    } finally {
      vi.useRealTimers();
    }
  });
});
