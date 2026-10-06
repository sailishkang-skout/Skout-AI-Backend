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
