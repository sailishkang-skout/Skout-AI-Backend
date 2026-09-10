import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { schema } from "@skout/db";
import type { FastifyInstance } from "fastify";
import { isMeetingBotConfigured, scheduleMeetingBot } from "../services/meeting-bot.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("meeting-auto-join-worker");

const { meetings } = schema;

/** How often to poll for meetings that need their bot auto-scheduled. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Schedule the bot once a meeting is within this window of starting — not the instant it's
 * created, since Recall.ai (and most vendors) join right when the bot is scheduled rather than
 * waiting for the meeting time, and scheduling days early risks the bot joining an empty room. */
const LOOKAHEAD_MS = 30 * 60 * 1000;

/**
 * R16.2 — opt-in auto-join. apps/crm has no BullMQ/cron infra (that's an apps/api-only
 * dependency today), so this is a lightweight in-process poller rather than a new queue: the
 * CRM service is already a long-running Node process (see index.ts's app.listen), so a
 * setInterval here is safe and doesn't need new infrastructure. Finds meetings with
 * `autoJoinBot = true`, a `meetingUrl`, `botStatus = "not_scheduled"`, and a `scheduledAt`
 * inside the lookahead window, and schedules the bot exactly the way the manual
 * "Schedule bot" button does (same service call, same webhook URL construction).
 */
export function startMeetingAutoJoinWorker(app: FastifyInstance): NodeJS.Timeout | null {
  if (!app.db) {
    log.warn("meeting auto-join worker not started — database unavailable");
    return null;
  }

  const tick = async () => {
    if (!app.db || !isMeetingBotConfigured(app.config)) return;

    const now = new Date();
    const horizon = new Date(now.getTime() + LOOKAHEAD_MS);

    let due: (typeof meetings.$inferSelect)[] = [];
    try {
      due = await app.db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.autoJoinBot, true),
            eq(meetings.botStatus, "not_scheduled"),
            isNull(meetings.deletedAt),
            gte(meetings.scheduledAt, now),
            lte(meetings.scheduledAt, horizon)
          )
        );
    } catch (err) {
      log.error("meeting auto-join poll query failed", err as Error);
      return;
    }

    for (const meeting of due) {
      if (!meeting.meetingUrl) continue;

      const base = app.config.CRM_PUBLIC_URL ?? app.config.FRONTEND_URL;
      if (!base) {
        log.warn("cannot auto-schedule meeting bot — no CRM_PUBLIC_URL/FRONTEND_URL configured", {
          meetingId: meeting.id,
        });
        continue;
      }

      try {
        const webhookUrl = new URL("/api/v1/meetings/webhook", base);
        if (app.config.MEETING_BOT_WEBHOOK_SECRET) {
          webhookUrl.searchParams.set("secret", app.config.MEETING_BOT_WEBHOOK_SECRET);
        }
        const { botExternalId } = await scheduleMeetingBot(app.config, meeting.meetingUrl, webhookUrl.toString());
        await app.db
          .update(meetings)
          .set({ botExternalId, botStatus: "scheduled", updatedAt: new Date() })
          .where(eq(meetings.id, meeting.id));
        log.info("auto-scheduled meeting bot", { meetingId: meeting.id, workspaceId: meeting.workspaceId });
      } catch (err) {
        // Best-effort — leave botStatus as "not_scheduled" so the next tick (or a manual click)
        // retries; don't mark "failed" for what might just be a transient vendor error.
        log.warn("failed to auto-schedule meeting bot", { err, meetingId: meeting.id });
      }
    }
  };

  void tick();
  return setInterval(() => void tick(), POLL_INTERVAL_MS);
}
