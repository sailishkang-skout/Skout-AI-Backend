import { describe, expect, it, vi } from "vitest";
import {
  DAILY_SCRAPE_CRON,
  DAILY_SCRAPE_SCHEDULER_ID,
  dailyScrapeSeeds,
  startDailyScrapeSchedule,
} from "./daily-schedule.js";

describe("dailyScrapeSeeds", () => {
  it("falls back to the historical default seeds", () => {
    expect(dailyScrapeSeeds({})).toEqual(["stripe.com", "shopify.com", "notion.so"]);
  });

  it("parses, trims and drops empty entries from SCRAPE_DAILY_SEEDS", () => {
    expect(dailyScrapeSeeds({ SCRAPE_DAILY_SEEDS: " a.com, ,b.com ," })).toEqual(["a.com", "b.com"]);
  });
});

describe("startDailyScrapeSchedule", () => {
  it("upserts one UTC Mon-Fri 03:00 scheduler that enqueues the company-web scrape", async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await startDailyScrapeSchedule({ upsertJobScheduler } as never, { SCRAPE_DAILY_SEEDS: "a.com" });

    expect(DAILY_SCRAPE_CRON).toBe("0 3 * * 1-5");
    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      DAILY_SCRAPE_SCHEDULER_ID,
      { pattern: "0 3 * * 1-5", tz: "UTC" },
      { name: "schedule", data: { source: "company-web", seeds: ["a.com"] } }
    );
  });

  it("is idempotent: calling twice reuses the same scheduler id", async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await startDailyScrapeSchedule({ upsertJobScheduler } as never, {});
    await startDailyScrapeSchedule({ upsertJobScheduler } as never, {});
    const ids = upsertJobScheduler.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(1);
  });
});
