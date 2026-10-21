import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { analyticsSafeProperties, serverAnalyticsEventName } from "@skout/shared";

/**
 * COPS-13 warehouse feed (Bible p.87): the analytics store is fed from the outbox, not by querying
 * the operational DB. One checkpoint per sink over published events in (published_at, id) order (an event
 * published late after a relay retry still comes after the checkpoint); a
 * batch moves the checkpoint only when the sink accepted it, so a failure resends the same batch.
 * The first sink is PostHog batch capture: each event keeps its event_id as the PostHog uuid (the
 * sink dedupes a resend), the canonical `cops.server.*` name, `schema_version`, the workspace as
 * a group, and ids, enums and numbers only. Without a PostHog project key the feed is off.
 */
const { copsOutbox, copsAnalyticsFeedCheckpoints } = schema;

export interface FeedConfig {
  apiKey?: string;
  host: string;
  batchSize?: number;
  fetchImpl?: typeof fetch;
  /** Checkpoint name; one per sink (tests use their own). */
  sink?: string;
}

export const FEED_SINK = "posthog";

type Envelope = { event_id: string; event_type: string; schema_version?: number; tenant_id: string; aggregate_type: string; aggregate_id: string; occurred_at: string; payload: Record<string, unknown> };

export function toPosthogEvent(e: Envelope) {
  return {
    event: serverAnalyticsEventName(e.event_type),
    uuid: e.event_id,
    distinct_id: `workspace:${e.tenant_id}`,
    timestamp: e.occurred_at,
    properties: {
      ...analyticsSafeProperties(e.payload ?? {}),
      schema_version: e.schema_version ?? 1,
      domain_event: e.event_type,
      aggregate_type: e.aggregate_type,
      workspace_id: e.tenant_id,
      $groups: { workspace: e.tenant_id },
      $process_person_profile: false,
    },
  };
}

async function checkpoint(db: Db, sink = FEED_SINK) {
  const [row] = await db.select().from(copsAnalyticsFeedCheckpoints).where(eq(copsAnalyticsFeedCheckpoints.sink, sink)).limit(1);
  return row ?? null;
}

/** Postgres keeps microseconds, the checkpoint (a JS Date) milliseconds: compare at milliseconds. */
const publishedMs = sql`date_trunc('milliseconds', ${copsOutbox.publishedAt})`;
const after = (cp: { lastCreatedAt: Date | null; lastEventId: string | null } | null) =>
  cp?.lastCreatedAt && cp.lastEventId ? sql`(${publishedMs}, ${copsOutbox.id}) > (${cp.lastCreatedAt.toISOString()}::timestamptz, ${cp.lastEventId}::uuid)` : undefined;

/** Sends one batch. Returns how many events the sink accepted. */
export async function runAnalyticsFeed(db: Db, cfg: FeedConfig, now = new Date()): Promise<{ enabled: boolean; sent: number; error?: string }> {
  if (!cfg.apiKey) return { enabled: false, sent: 0 };
  const sink = cfg.sink ?? FEED_SINK;
  const cp = await checkpoint(db, sink);
  const rows = await db
    .select({ id: copsOutbox.id, publishedAt: copsOutbox.publishedAt, envelope: copsOutbox.envelope })
    .from(copsOutbox)
    .where(and(isNotNull(copsOutbox.publishedAt), after(cp)))
    .orderBy(asc(publishedMs), asc(copsOutbox.id))
    .limit(cfg.batchSize ?? 500);
  if (rows.length === 0) {
    await upsert(db, sink, { lastRunAt: now });
    return { enabled: true, sent: 0 };
  }
  const batch = rows.map((r) => toPosthogEvent(r.envelope as Envelope));
  let error: string | undefined;
  try {
    const res = await (cfg.fetchImpl ?? fetch)(`${cfg.host.replace(/\/+$/, "")}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: cfg.apiKey, batch }),
    });
    if (!res.ok) error = `PostHog answered ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : "PostHog unreachable";
  }
  if (error) {
    await upsert(db, sink, { lastRunAt: now, lastError: error.slice(0, 500) });
    return { enabled: true, sent: 0, error };
  }
  const last = rows[rows.length - 1]!;
  await upsert(db, sink, { lastRunAt: now, lastError: null, lastCreatedAt: last.publishedAt!, lastEventId: last.id, sentDelta: rows.length });
  return { enabled: true, sent: rows.length };
}

async function upsert(db: Db, sink: string, v: { lastRunAt: Date; lastError?: string | null; lastCreatedAt?: Date; lastEventId?: string; sentDelta?: number }) {
  const values = {
    sink,
    lastRunAt: v.lastRunAt,
    updatedAt: v.lastRunAt,
    ...(v.lastError !== undefined ? { lastError: v.lastError } : {}),
    ...(v.lastCreatedAt ? { lastCreatedAt: v.lastCreatedAt, lastEventId: v.lastEventId } : {}),
  };
  await db
    .insert(copsAnalyticsFeedCheckpoints)
    .values({ ...values, eventsSent: v.sentDelta ?? 0 })
    .onConflictDoUpdate({
      target: copsAnalyticsFeedCheckpoints.sink,
      set: { ...values, eventsSent: sql`${copsAnalyticsFeedCheckpoints.eventsSent} + ${v.sentDelta ?? 0}` },
    });
}

/**
 * Feed health for a workspace admin: on or off, where the checkpoint is, and how many of this
 * workspace's events are behind it. Other workspaces' volumes are not shown.
 */
export async function feedStatus(db: Db, cfg: Pick<FeedConfig, "apiKey" | "sink">, workspaceId: string) {
  const cp = await checkpoint(db, cfg.sink);
  const [lag] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(copsOutbox)
    .where(and(eq(copsOutbox.tenantId, workspaceId), isNotNull(copsOutbox.publishedAt), after(cp)));
  return {
    sink: cfg.sink ?? FEED_SINK,
    enabled: Boolean(cfg.apiKey),
    checkpoint_at: cp?.lastCreatedAt?.toISOString() ?? null,
    lag_events: lag?.n ?? 0,
    last_run_at: cp?.lastRunAt?.toISOString() ?? null,
    last_error: cp?.lastError ?? null,
  };
}
