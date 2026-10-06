import type { Queue } from "bullmq";

export const DAILY_SCRAPE_SCHEDULER_ID = "daily-scrape";

/** Mon–Fri 03:00 UTC — identical to the former EventBridge rule `DailyScrapeSchedule`. */
export const DAILY_SCRAPE_CRON = "0 3 * * 1-5";

const FALLBACK_SEEDS = "stripe.com,shopify.com,notion.so";

export function dailyScrapeSeeds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SCRAPE_DAILY_SEEDS ?? FALLBACK_SEEDS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The daily scrape used to run only where SCRAPE_SCHEDULE_QUEUE_URL was set (the SQS opt-in). Keep that
 * working, and let new environments opt in explicitly with SCRAPE_DAILY_SCHEDULE_ENABLED=true.
 * An explicit "false" always wins. Off by default so local `scrapers:dev` does not schedule scrapes.
 */
export function isDailyScheduleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.SCRAPE_DAILY_SCHEDULE_ENABLED?.trim().toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;
  return Boolean(env.SCRAPE_SCHEDULE_QUEUE_URL?.trim());
}

/** Enable or disable the scheduler to match the environment; disabling removes a persisted schedule. */
export async function syncDailyScrapeSchedule(
  queue: Pick<Queue, "upsertJobScheduler" | "removeJobScheduler">,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (isDailyScheduleEnabled(env)) {
    await startDailyScrapeSchedule(queue, env);
  } else {
    await queue.removeJobScheduler(DAILY_SCRAPE_SCHEDULER_ID);
  }
}

/**
 * Register the daily scrape as a BullMQ job scheduler on the `scrape-schedule` queue.
 * Idempotent by scheduler id, so every orchestrator replica/restart can call it safely.
 */
export async function startDailyScrapeSchedule(
  queue: Pick<Queue, "upsertJobScheduler">,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await queue.upsertJobScheduler(
    DAILY_SCRAPE_SCHEDULER_ID,
    { pattern: DAILY_SCRAPE_CRON, tz: "UTC" },
    { name: "schedule", data: { source: "company-web", seeds: dailyScrapeSeeds(env) } }
  );
}
