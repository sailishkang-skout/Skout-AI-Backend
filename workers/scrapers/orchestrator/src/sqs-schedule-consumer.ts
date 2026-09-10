import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { scrapeJobRequestSchema, scrapeSourceEnum } from "@skout/scraper-contracts";
import { enqueueScrapeJob } from "./index.js";

const DEFAULT_SEEDS = (process.env.SCRAPE_DAILY_SEEDS ?? "stripe.com,shopify.com,notion.so")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Poll SQS schedule queue (EventBridge cron) and enqueue BullMQ scrape jobs. */
export function startSqsScheduleConsumer(): () => void {
  const queueUrl = process.env.SCRAPE_SCHEDULE_QUEUE_URL?.trim();
  if (!queueUrl) {
    console.log("[orchestrator] SCRAPE_SCHEDULE_QUEUE_URL unset — SQS schedule consumer disabled");
    return () => undefined;
  }

  const region = process.env.AWS_REGION ?? "us-east-1";
  const client = new SQSClient({ region });
  let stopped = false;

  const poll = async () => {
    while (!stopped) {
      try {
        const res = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 300,
          })
        );

        for (const msg of res.Messages ?? []) {
          if (!msg.ReceiptHandle) continue;
          try {
            const body = msg.Body ? JSON.parse(msg.Body) : {};
            const isDailyCron = body.action === "schedule_daily_scrape";
            const source = isDailyCron
              ? "company-web"
              : typeof body.scrapeSource === "string" && scrapeSourceEnum.safeParse(body.scrapeSource).success
                ? body.scrapeSource
                : scrapeSourceEnum.safeParse(body.source).success
                  ? body.source
                  : "company-web";
            const seeds = Array.isArray(body.seeds)
              ? body.seeds.map(String)
              : DEFAULT_SEEDS;
            const request = scrapeJobRequestSchema.parse({ source, seeds });
            const manifest = await enqueueScrapeJob(request);
            console.log("[orchestrator] SQS schedule enqueued scrape job", manifest.jobId, source);
          } catch (err) {
            console.error("[orchestrator] SQS schedule message failed:", err);
          }
          await client.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle })
          );
        }
      } catch (err) {
        console.error("[orchestrator] SQS poll error:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  void poll();
  console.log("[orchestrator] SQS schedule consumer started", queueUrl);

  return () => {
    stopped = true;
  };
}
