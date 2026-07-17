import { Worker, Queue } from "bullmq";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { checkDomainBlacklist } from "../services/blacklist-check.service.js";

const log = createLogger("blacklist-monitor.worker");

const QUEUE_NAME = "blacklist-monitor";

export async function startBlacklistMonitorWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — blacklist monitor worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — blacklist monitor worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  // Schedule a repeating cron job — runs every N hours (default 6)
  const cronExpression = `0 */${config.DNSBL_CHECK_INTERVAL_HOURS} * * *`;
  await queue.upsertJobScheduler(
    "blacklist-check-all-domains",
    { pattern: cronExpression },
    { name: "blacklist-check-all-domains", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      log.info("Starting blacklist check for all active sending domains");

      const domains = await db
        .select({
          id: schema.sendingDomains.id,
          domain: schema.sendingDomains.domain,
        })
        .from(schema.sendingDomains)
        .where(eq(schema.sendingDomains.status, "verified"));

      if (domains.length === 0) {
        log.info("No verified domains to check");
        return;
      }

      log.info(`Checking ${domains.length} domains against DNSBL lists`);

      for (const row of domains) {
        try {
          const result = await checkDomainBlacklist(row.domain);
          const now = new Date();

          await db
            .update(schema.sendingDomains)
            .set({
              blacklistStatus: result.status === "error" ? "clean" : result.status,
              blacklistedOn: result.listedOn,
              lastCheckedAt: now,
              checkError: result.error ?? null,
              updatedAt: now,
            })
            .where(eq(schema.sendingDomains.id, row.id));

          if (result.status === "blacklisted") {
            log.warn(
              `Domain ${row.domain} is blacklisted on: ${result.listedOn.join(", ")}`,
              { domainId: row.id }
            );
          } else if (result.status === "error") {
            log.warn(
              `Blacklist check error for ${row.domain}: ${result.error}`,
              { domainId: row.id }
            );
          } else {
            log.debug(`Domain ${row.domain} is clean`, { domainId: row.id });
          }
        } catch (err) {
          log.error(`Unexpected error checking domain ${row.domain}`, {
            domainId: row.id,
            err,
          });
        }
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Blacklist monitor job failed", { jobId: job?.id, err });
  });

  log.info(`Blacklist monitor worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

// Allow running directly: `tsx apps/api/src/workers/blacklist-monitor.worker.ts`
if (process.argv[1]?.endsWith("blacklist-monitor.worker.ts") || process.argv[1]?.endsWith("blacklist-monitor.worker.js")) {
  const config = loadEnv();
  startBlacklistMonitorWorker(config).then(() => {
    log.info("Blacklist monitor worker running standalone");
  });
}
