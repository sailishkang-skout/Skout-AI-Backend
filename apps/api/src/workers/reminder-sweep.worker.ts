import { Worker, Queue } from "bullmq";
import { and, eq, inArray, isNull, lte, notExists, sql } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { createNotification } from "../services/notification.service.js";

const log = createLogger("reminder-sweep.worker");

const QUEUE_NAME = "reminder-sweep";

export async function startReminderSweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — reminder sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — reminder sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.REMINDER_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "reminder-sweep-all",
    { pattern: cronExpression },
    { name: "reminder-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { tasks, sequenceEnrollmentSteps, sequenceSteps, sequenceEnrollments, aiDrafts, notifications } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const now = new Date();
      const leadCutoff = new Date(now.getTime() + config.REMINDER_LEAD_HOURS * 60 * 60 * 1000);
      const staleCutoff = new Date(now.getTime() - config.REMINDER_LEAD_HOURS * 60 * 60 * 1000);

      await sweepTasks(db, tasks, notifications, leadCutoff);
      await sweepSequenceSteps(
        db,
        sequenceEnrollmentSteps,
        sequenceSteps,
        sequenceEnrollments,
        notifications,
        leadCutoff
      );
      await sweepAiDrafts(db, aiDrafts, notifications, staleCutoff);
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Reminder sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Reminder sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

type Db = ReturnType<typeof createDb>["db"];

export async function sweepTasks(
  db: Db,
  tasks: (typeof schema)["tasks"],
  notifications: (typeof schema)["notifications"],
  leadCutoff: Date
) {
  const due = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "open"),
        isNull(tasks.deletedAt),
        sql`${tasks.dueDate} IS NOT NULL`,
        lte(tasks.dueDate, leadCutoff),
        notExists(
          db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.entityType, "task"),
                eq(notifications.entityId, sql`${tasks.id}::text`)
              )
            )
        )
      )
    );

  for (const task of due) {
    try {
      await createNotification(db, {
        workspaceId: task.workspaceId,
        userId: task.assignedTo,
        type: "task_reminder",
        entityType: "task",
        entityId: task.id,
        title: `${task.type === "custom" ? "Task" : task.type[0]!.toUpperCase() + task.type.slice(1)} "${task.title}" is due soon`,
        body: task.dueDate ? `Due ${task.dueDate.toISOString()}` : null,
      });
    } catch (err) {
      log.error(`Failed to create reminder for task ${task.id}`, { taskId: task.id, err });
    }
  }

  if (due.length > 0) log.info(`Created ${due.length} task reminder(s)`);
}

export async function sweepSequenceSteps(
  db: Db,
  sequenceEnrollmentSteps: (typeof schema)["sequenceEnrollmentSteps"],
  sequenceSteps: (typeof schema)["sequenceSteps"],
  sequenceEnrollments: (typeof schema)["sequenceEnrollments"],
  notifications: (typeof schema)["notifications"],
  leadCutoff: Date
) {
  const due = await db
    .select({
      id: sequenceEnrollmentSteps.id,
      workspaceId: sequenceEnrollments.workspaceId,
      scheduledAt: sequenceEnrollmentSteps.scheduledAt,
      linkedinAction: sequenceSteps.linkedinAction,
    })
    .from(sequenceEnrollmentSteps)
    .innerJoin(sequenceSteps, eq(sequenceSteps.id, sequenceEnrollmentSteps.stepId))
    .innerJoin(sequenceEnrollments, eq(sequenceEnrollments.id, sequenceEnrollmentSteps.enrollmentId))
    .where(
      and(
        eq(sequenceSteps.stepType, "linkedin"),
        eq(sequenceEnrollmentSteps.status, "pending"),
        sql`${sequenceEnrollmentSteps.scheduledAt} IS NOT NULL`,
        lte(sequenceEnrollmentSteps.scheduledAt, leadCutoff),
        notExists(
          db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.entityType, "sequence_enrollment_step"),
                eq(notifications.entityId, sql`${sequenceEnrollmentSteps.id}::text`)
              )
            )
        )
      )
    );

  for (const step of due) {
    try {
      await createNotification(db, {
        workspaceId: step.workspaceId,
        type: "sequence_reminder",
        entityType: "sequence_enrollment_step",
        entityId: step.id,
        title: `LinkedIn ${step.linkedinAction ?? "step"} is due soon`,
        body: step.scheduledAt ? `Scheduled for ${step.scheduledAt.toISOString()}` : null,
      });
    } catch (err) {
      log.error(`Failed to create reminder for sequence step ${step.id}`, { stepId: step.id, err });
    }
  }

  if (due.length > 0) log.info(`Created ${due.length} sequence step reminder(s)`);
}

export async function sweepAiDrafts(
  db: Db,
  aiDrafts: (typeof schema)["aiDrafts"],
  notifications: (typeof schema)["notifications"],
  staleCutoff: Date
) {
  const due = await db
    .select()
    .from(aiDrafts)
    .where(
      and(
        inArray(aiDrafts.status, ["pending_review", "edited"]),
        lte(aiDrafts.createdAt, staleCutoff),
        notExists(
          db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.entityType, "ai_draft"),
                eq(notifications.entityId, sql`${aiDrafts.id}::text`)
              )
            )
        )
      )
    );

  for (const draft of due) {
    try {
      await createNotification(db, {
        workspaceId: draft.workspaceId,
        type: "draft_reminder",
        entityType: "ai_draft",
        entityId: draft.id,
        title: `AI draft "${draft.subject}" is awaiting review`,
        body: `Created ${draft.createdAt.toISOString()}`,
      });
    } catch (err) {
      log.error(`Failed to create reminder for AI draft ${draft.id}`, { draftId: draft.id, err });
    }
  }

  if (due.length > 0) log.info(`Created ${due.length} AI draft reminder(s)`);
}

if (
  process.argv[1]?.endsWith("reminder-sweep.worker.ts") ||
  process.argv[1]?.endsWith("reminder-sweep.worker.js")
) {
  const config = loadEnv();
  startReminderSweepWorker(config).then(() => {
    log.info("Reminder sweep worker running standalone");
  });
}
