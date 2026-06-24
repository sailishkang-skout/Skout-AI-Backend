export const SCRAPE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: 100,
  removeOnFail: 200,
};

/** BullMQ queue names (no `:` — BullMQ 5.7+ restriction). */
export const SCRAPE_QUEUES = {
  schedule: "scrape-schedule",
  clean: "scrape-clean",
  ingest: "scrape-ingest",
  companyWeb: "scrape-company-web",
  linkedin: "scrape-linkedin",
  opencorporates: "scrape-opencorporates",
  secEdgar: "scrape-sec-edgar",
} as const;

export type BotQueue =
  | typeof SCRAPE_QUEUES.companyWeb
  | typeof SCRAPE_QUEUES.linkedin
  | typeof SCRAPE_QUEUES.opencorporates
  | typeof SCRAPE_QUEUES.secEdgar;

export function queueForSource(source: string): BotQueue {
  switch (source) {
    case "company-web":
      return SCRAPE_QUEUES.companyWeb;
    case "linkedin":
      return SCRAPE_QUEUES.linkedin;
    case "opencorporates":
      return SCRAPE_QUEUES.opencorporates;
    case "sec-edgar":
      return SCRAPE_QUEUES.secEdgar;
    default:
      throw new Error(`Unknown scrape source: ${source}`);
  }
}

export interface ScrapeJobPayload {
  jobId: string;
  source: string;
  seeds: string[];
  options?: Record<string, unknown>;
}

export interface CleanJobPayload {
  jobId: string;
  source: string;
  rawS3Key: string;
}

export interface IngestJobPayload {
  jobId: string;
  source: string;
  cleanS3Key: string;
}
