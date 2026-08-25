import { Worker, Queue } from "bullmq";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { sendMail } from "../services/mail.service.js";

const log = createLogger("alert-digest-sweep.worker");

const QUEUE_NAME = "alert-digest-sweep";
const DIGEST_TYPE = "signal_alert";

type Db = ReturnType<typeof createDb>["db"];

/**
 * R17.3 — daily digest for users who prefer `notification_preferences.digest = true` on
 * `signal_alert`, instead of the real-time email `createNotification` already sent for
 * everyone else. The in-app notification row was created immediately either way; this only
 * batches the *email* side for digest-preferring users.
 */
export async function runAlertDigestSweep(db: Db, config: Env): Promise<{ emailed: number; skipped: number }> {
  const { notifications, notificationPreferences, users } = schema;

  const pending = await db
    .select({
      id: notifications.id,
      workspaceId: notifications.workspaceId,
      userId: notifications.userId,
      title: notifications.title,
      body: notifications.body,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(eq(notifications.type, DIGEST_TYPE), isNull(notifications.digestedAt)));

  if (pending.length === 0) return { emailed: 0, skipped: 0 };

  const byUser = new Map<string, typeof pending>();
  for (const row of pending) {
    if (!row.userId) continue;
    const key = `${row.workspaceId}:${row.userId}`;
    const bucket = byUser.get(key) ?? [];
    bucket.push(row);
    byUser.set(key, bucket);
  }

  let emailed = 0;
  let skipped = 0;

  for (const [key, rows] of byUser) {
    const [workspaceId, userId] = key.split(":") as [string, string];
    const ids = rows.map((r) => r.id);

    try {
      const [pref] = await db
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.workspaceId, workspaceId),
            eq(notificationPreferences.userId, userId),
            eq(notificationPreferences.type, DIGEST_TYPE)
          )
        )
        .limit(1);

      const wantsDigestEmail = !!pref?.digest && (pref.channel === "email" || pref.channel === "both");
      if (!wantsDigestEmail) {
        skipped += rows.length;
        continue;
      }

      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.email) {
        skipped += rows.length;
        continue;
      }

      const lines = rows.map((r) => `• ${r.title}${r.body ? ` — ${r.body}` : ""}`);
      const html = `<p><strong>${rows.length} signal alert${rows.length === 1 ? "" : "s"} today</strong></p><ul>${rows
        .map((r) => `<li><strong>${r.title}</strong>${r.body ? ` — ${r.body}` : ""}</li>`)
        .join("")}</ul>`;

      const mail = await sendMail(config, {
        to: user.email,
        subject: `${rows.length} signal alert${rows.length === 1 ? "" : "s"} — daily digest`,
        text: lines.join("\n"),
        html,
      });
      if (mail.sent) emailed += rows.length;
      else skipped += rows.length;
    } catch (err) {
      log.error("Failed to send digest for user", { workspaceId, userId, err });
      skipped += rows.length;
    } finally {
      await db
        .update(notifications)
        .set({ digestedAt: new Date() })
        .where(inArray(notifications.id, ids));
    }
  }

  return { emailed, skipped };
}

export async function startAlertDigestSweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — alert digest sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — alert digest sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.ALERT_DIGEST_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "alert-digest-sweep-all",
    { pattern: cronExpression },
    { name: "alert-digest-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // §11.3 Task 33 — this worker is self-triggered on a cron schedule, not invoked from a
      // synchronous request, so there's no upstream trace to continue; this is a root span.
      await withSpan("alert-digest-sweep.tick", async () => {
        const { emailed, skipped } = await runAlertDigestSweep(db, config);
        if (emailed || skipped) {
          log.info(`Alert digest sweep: emailed ${emailed}, skipped ${skipped}`);
        }
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Alert digest sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Alert digest sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("alert-digest-sweep.worker.ts") ||
  process.argv[1]?.endsWith("alert-digest-sweep.worker.js")
) {
  const config = loadEnv();
  startAlertDigestSweepWorker(config).then(() => {
    log.info("Alert digest sweep worker running standalone");
  });
}
