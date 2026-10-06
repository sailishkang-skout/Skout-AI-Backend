import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { createDb, schema } from "@skout/db";
import { captureException, createLogger, withSpan } from "@skout/observability";
import { parseCopsEvent, relayCopsOutboxRow, type CopsOutboxUpdate } from "@skout/shared";
import type { Env } from "../config/env.js";
import { isRedisAvailable } from "../lib/redis.js";
import { DEXTER_EVENT_QUEUE, getDexterEventQueue } from "./dexter-event.queue.js";

const log = createLogger("cops-outbox-relay.worker");

/** COPS envelopes share the existing Skout event spine and worker. */
export const COPS_EVENTS_QUEUE = DEXTER_EVENT_QUEUE;
const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1_000;
/** Wait after a failed pass so a down Redis is not hammered or spammed to Sentry. */
const FAILURE_BACKOFF_MS = 30_000;

/**
 * Map a relay decision to the columns it writes. Kept pure so the update rules are testable
 * without a database.
 */
export function copsOutboxUpdateToSet(update: CopsOutboxUpdate) {
  switch (update.kind) {
    case "published":
      return { publishedAt: update.publishedAt };
    case "retry":
      return {
        attempts: update.attempts,
        nextAttemptAt: update.nextAttemptAt,
        lastError: update.lastError,
      };
    case "dead_letter":
      return {
        attempts: update.attempts,
        deadLetteredAt: update.deadLetteredAt,
        lastError: update.lastError,
      };
  }
}

/**
 * One relay pass: read due rows in commit order, publish each through `publish`, and write back
 * the outcome. Rows are published with `jobId = event_id`, so a retry after a crash between publish
 * and write-back does not create a second job in BullMQ.
 */
export async function runCopsOutboxRelayOnce(
  db: Db,
  publish: (envelope: unknown, eventId: string) => Promise<void>,
  now: Date = new Date()
): Promise<{ picked: number; published: number; retried: number; deadLettered: number }> {
  const { copsOutbox } = schema;
  const due = await db
    .select({ id: copsOutbox.id, attempts: copsOutbox.attempts, envelope: copsOutbox.envelope })
    .from(copsOutbox)
    .where(
      and(
        isNull(copsOutbox.publishedAt),
        isNull(copsOutbox.deadLetteredAt),
        lte(copsOutbox.nextAttemptAt, now)
      )
    )
    .orderBy(asc(copsOutbox.createdAt))
    .limit(BATCH_SIZE);

  const counts = { picked: due.length, published: 0, retried: 0, deadLettered: 0 };
  for (const row of due) {
    const update = await relayCopsOutboxRow(
      row,
      (envelope) => publish(envelope, row.id),
      now
    );
    await db.update(copsOutbox).set(copsOutboxUpdateToSet(update)).where(eq(copsOutbox.id, row.id));
    if (update.kind === "published") counts.published++;
    else if (update.kind === "retry") counts.retried++;
    else counts.deadLettered++;
  }
  return counts;
}

/** Starts the polling loop. Returns a stop function. Skips quietly when Redis is not configured. */
export async function startCopsOutboxRelay(db: Db, config: Env): Promise<() => Promise<void>> {
  if (!(await isRedisAvailable(config))) {
    log.warn("cops-outbox relay not started: Redis is not configured");
    return async () => {};
  }
  const queue = getDexterEventQueue(config);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activePass: Promise<void> | null = null;
  let consecutiveFailures = 0;

  const tick = async () => {
    if (stopped) return;
    activePass = (async () => {
      try {
        const counts = await runCopsOutboxRelayOnce(db, async (envelope, eventId) => {
          const event = parseCopsEvent(envelope);
          await withSpan("cops.outbox.publish", async (span) => {
            span.setAttribute("cops.event_id", eventId);
            span.setAttribute("cops.correlation_id", event.correlation_id);
            await queue.add(
              "process-event",
              { event },
              { jobId: eventId }
            );
          });
        });
        consecutiveFailures = 0;
        if (counts.picked > 0) log.info("cops-outbox relay pass", counts);
      } catch (err) {
        consecutiveFailures++;
        // Back off after a failure so a down Redis is not retried every second or spammed to Sentry.
        if (consecutiveFailures === 1) {
          log.error("cops-outbox relay pass failed", { error: String(err) });
          captureException(err, { component: "cops-outbox-relay" });
        }
      } finally {
        activePass = null;
        const delay = consecutiveFailures > 0 ? FAILURE_BACKOFF_MS : POLL_INTERVAL_MS;
        if (!stopped) timer = setTimeout(() => void tick(), delay);
      }
    })();
    await activePass;
  };
  void tick();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await activePass;
  };
}

/** Boot entry used by index.ts. Mirrors the other workers: no DATABASE_URL or Redis means disabled. */
export async function startCopsOutboxRelayWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — cops-outbox relay disabled");
    return async () => {};
  }
  const database = createDb(config.DATABASE_URL);
  const stopRelay = await startCopsOutboxRelay(database.db, config);
  return async () => {
    await stopRelay();
    await database.sql.end();
  };
}
