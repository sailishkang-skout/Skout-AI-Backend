import { describe, expect, it, vi } from "vitest";
import {
  DAILY_SCRAPE_CRON,
  DAILY_SCRAPE_SCHEDULER_ID,
  dailyScrapeSeeds,
  isDailyScheduleEnabled,
  startDailyScrapeSchedule,
  syncDailyScrapeSchedule,
} from "./daily-schedule.js";

describe("isDailyScheduleEnabled", () => {
  it("is off by default, so local scrapers:dev does not schedule daily scrapes", () => {
    expect(isDailyScheduleEnabled({})).toBe(false);
  });

  it("is on with SCRAPE_DAILY_SCHEDULE_ENABLED=true", () => {
    expect(isDailyScheduleEnabled({ SCRAPE_DAILY_SCHEDULE_ENABLED: "true" })).toBe(true);
  });

  it("stays on for deployments that already set the legacy SCRAPE_SCHEDULE_QUEUE_URL opt-in", () => {
    expect(isDailyScheduleEnabled({ SCRAPE_SCHEDULE_QUEUE_URL: "https://sqs.example/queue" })).toBe(true);
    expect(isDailyScheduleEnabled({ SCRAPE_SCHEDULE_QUEUE_URL: "   " })).toBe(false);
  });

  it("an explicit SCRAPE_DAILY_SCHEDULE_ENABLED=false wins over the legacy opt-in", () => {
    expect(
      isDailyScheduleEnabled({ SCRAPE_DAILY_SCHEDULE_ENABLED: "false", SCRAPE_SCHEDULE_QUEUE_URL: "https://sqs.example/q" })
    ).toBe(false);
  });
});

describe("syncDailyScrapeSchedule", () => {
  it("registers the scheduler when enabled", async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined), removeJobScheduler: vi.fn() };
    await syncDailyScrapeSchedule(queue as never, { SCRAPE_DAILY_SCHEDULE_ENABLED: "true" });
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("removes a previously persisted scheduler when disabled, so a turned-off environment stops scraping", async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn().mockResolvedValue(true) };
    await syncDailyScrapeSchedule(queue as never, {});
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(DAILY_SCRAPE_SCHEDULER_ID);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });
});

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
