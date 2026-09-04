import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { CrmSyncEntityType } from "@skout/shared";

const { crmConnections, crmSyncCheckpoints, crmNativeLinks } = schema;

export async function getHubSpotConnectionId(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: crmConnections.id })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, "hubspot")))
    .limit(1);
  return row?.id ?? null;
}

interface Checkpoint {
  id: string;
  cursor: Date | null;
}

async function getOrCreateCheckpoint(
  db: Db,
  workspaceId: string,
  connectionId: string,
  entityType: CrmSyncEntityType
): Promise<Checkpoint> {
  const where = scopedTo(
    crmSyncCheckpoints,
    workspaceId,
    eq(crmSyncCheckpoints.connectionId, connectionId),
    eq(crmSyncCheckpoints.entityType, entityType)
  );

  const [existing] = await db
    .select({ id: crmSyncCheckpoints.id, cursor: crmSyncCheckpoints.cursor })
    .from(crmSyncCheckpoints)
    .where(where)
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(crmSyncCheckpoints)
    .values({ workspaceId, connectionId, entityType })
    .onConflictDoNothing()
    .returning({ id: crmSyncCheckpoints.id, cursor: crmSyncCheckpoints.cursor });
  if (created) return created;

  // Lost a race with a concurrent sync run creating the same (connectionId, entityType) row.
  const [raced] = await db
    .select({ id: crmSyncCheckpoints.id, cursor: crmSyncCheckpoints.cursor })
    .from(crmSyncCheckpoints)
    .where(where)
    .limit(1);
  if (!raced) throw new Error("failed to get or create crm_sync_checkpoints row");
  return raced;
}

export interface CheckpointedSyncOutcome<T> {
  result: T;
  /** The highest provider-side "last modified" timestamp observed this run, or null if nothing
   * was pulled. The checkpoint's cursor only advances to this value — never further — so a run
   * that throws before returning leaves the checkpoint exactly where it was. */
  maxModifiedAt: Date | null;
}

/**
 * §8.12 Task ADI-10 — wraps one incremental-pull run with checkpoint bookkeeping: reads the
 * current cursor, marks the run "running", then on success advances the cursor to `maxModifiedAt`
 * and marks "succeeded"; on failure marks "failed" with the error and leaves the cursor untouched.
 * This is the mechanism behind both acceptance criteria at once: incremental pulls only fetch
 * since the last checkpoint (via the `sinceIso` passed into `run`), and an interrupted run
 * resumes from the last checkpoint rather than from scratch (because the cursor never advances
 * past a run that didn't complete).
 */
export async function withSyncCheckpoint<T>(
  db: Db,
  workspaceId: string,
  connectionId: string,
  entityType: CrmSyncEntityType,
  run: (sinceIso: string) => Promise<CheckpointedSyncOutcome<T>>
): Promise<T> {
  const checkpoint = await getOrCreateCheckpoint(db, workspaceId, connectionId, entityType);
  const since = checkpoint.cursor ?? new Date(0);

  await db
    .update(crmSyncCheckpoints)
    .set({ lastRunStatus: "running", lastRunStartedAt: new Date(), updatedAt: new Date() })
    .where(eq(crmSyncCheckpoints.id, checkpoint.id));

  try {
    const { result, maxModifiedAt } = await run(since.toISOString());
    await db
      .update(crmSyncCheckpoints)
      .set({
        lastRunStatus: "succeeded",
        lastRunCompletedAt: new Date(),
        lastError: null,
        ...(maxModifiedAt ? { cursor: maxModifiedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(crmSyncCheckpoints.id, checkpoint.id));
    return result;
  } catch (err) {
    await db
      .update(crmSyncCheckpoints)
      .set({
        lastRunStatus: "failed",
        lastRunCompletedAt: new Date(),
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(crmSyncCheckpoints.id, checkpoint.id));
    throw err;
  }
}

/** Upserts the (connection, entityType, entityId) <-> externalId mapping, refreshing the
 * provider-side last-modified timestamp every time — this is what the outbound-write worker
 * checks to decide whether a queued push-back would overwrite a more recent provider-side edit. */
export async function upsertCrmNativeLink(
  db: Db,
  workspaceId: string,
  connectionId: string,
  entityType: CrmSyncEntityType,
  entityId: string,
  externalId: string,
  externalUpdatedAt: Date | null
): Promise<void> {
  await db
    .insert(crmNativeLinks)
    .values({ workspaceId, connectionId, entityType, entityId, externalId, externalUpdatedAt })
    .onConflictDoUpdate({
      target: [crmNativeLinks.connectionId, crmNativeLinks.entityType, crmNativeLinks.entityId],
      set: { externalId, externalUpdatedAt, updatedAt: new Date() },
    });
}

export async function getCrmNativeLink(
  db: Db,
  workspaceId: string,
  connectionId: string,
  entityType: CrmSyncEntityType,
  entityId: string
) {
  const [row] = await db
    .select()
    .from(crmNativeLinks)
    .where(
      scopedTo(
        crmNativeLinks,
        workspaceId,
        eq(crmNativeLinks.connectionId, connectionId),
        eq(crmNativeLinks.entityType, entityType),
        eq(crmNativeLinks.entityId, entityId)
      )
    )
    .limit(1);
  return row ?? null;
}
