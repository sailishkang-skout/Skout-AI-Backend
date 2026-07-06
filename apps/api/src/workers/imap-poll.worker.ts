import { Worker } from "bullmq";
import { and, eq, isNotNull } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { decryptSecret } from "../utils/integration-crypto.js";
import { ingestInboundMessage } from "../services/inbound-reply.service.js";
import { IMAP_POLL_QUEUE, scheduleImapPolling, type ImapPollJobPayload } from "./imap-poll.queue.js";
import { isRedisAvailable } from "../lib/redis.js";

const log = createLogger("imap-poll.worker");

const { inboxes } = schema;

type DbClient = ReturnType<typeof createDb>["db"];

// ---------------------------------------------------------------------------
// Poll a single inbox via IMAP
// ---------------------------------------------------------------------------

async function pollOneInbox(
  db: DbClient,
  config: Env,
  inbox: typeof inboxes.$inferSelect
): Promise<void> {
  if (!inbox.imapHost || !inbox.smtpUsername || !inbox.smtpPasswordEncrypted) {
    return;
  }

  const encryptionKey = config.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    log.warn("INTEGRATION_ENCRYPTION_KEY not configured — skipping IMAP poll", {
      inboxId: inbox.id,
    });
    return;
  }

  const password = decryptSecret(inbox.smtpPasswordEncrypted, encryptionKey);

  const client = new ImapFlow({
    host: inbox.imapHost,
    port: inbox.imapPort ?? 993,
    secure: true,
    auth: { user: inbox.smtpUsername, pass: password },
    logger: false,
  });

  try {
    await client.connect();

    const lock = await client.getMailboxLock("INBOX");
    try {
      // Fetch messages received since last poll (or last 7 days on first run)
      const since = inbox.imapLastPolledAt
        ? new Date(inbox.imapLastPolledAt)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      let count = 0;
      for await (const msg of client.fetch({ since }, { source: true })) {
        try {
          const parsed = await simpleParser(msg.source as Buffer);

          const fromAddress =
            parsed.from?.value[0]?.address ?? parsed.from?.text ?? "";
          if (!fromAddress) continue;

          const rawHeaders: Record<string, string> = {};
          parsed.headers.forEach((value, key) => {
            rawHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
          });

          const refs = Array.isArray(parsed.references)
            ? parsed.references.join(" ")
            : (parsed.references ?? undefined);

          await ingestInboundMessage(db, inbox.workspaceId, inbox.id, {
            fromAddress,
            toAddress: inbox.emailAddress,
            subject: parsed.subject ?? undefined,
            bodyText: parsed.text ?? undefined,
            bodyHtml: typeof parsed.html === "string" ? parsed.html : undefined,
            messageId: parsed.messageId ?? undefined,
            inReplyTo: parsed.inReplyTo ?? undefined,
            references: refs,
            sentAt: parsed.date ?? new Date(),
            rawHeaders,
          });

          count++;
        } catch (msgErr) {
          log.warn("Failed to parse/ingest one IMAP message", {
            inboxId: inbox.id,
            err: msgErr,
          });
        }
      }

      log.info("IMAP poll complete", { inboxId: inbox.id, newMessages: count });
    } finally {
      lock.release();
    }

    await db
      .update(inboxes)
      .set({ imapLastPolledAt: new Date(), updatedAt: new Date() })
      .where(eq(inboxes.id, inbox.id));
  } catch (err) {
    log.error("IMAP connection failed", err as Error, { inboxId: inbox.id, host: inbox.imapHost });
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore logout errors
    }
  }
}

// ---------------------------------------------------------------------------
// Poll all IMAP-configured inboxes (or a specific one)
// ---------------------------------------------------------------------------

async function pollInboxes(
  db: DbClient,
  config: Env,
  payload: ImapPollJobPayload
): Promise<void> {
  const rows = payload.inboxId
    ? await db
        .select()
        .from(inboxes)
        .where(and(eq(inboxes.id, payload.inboxId), eq(inboxes.status, "active")))
        .limit(1)
    : await db
        .select()
        .from(inboxes)
        .where(and(eq(inboxes.status, "active"), isNotNull(inboxes.imapHost)));

  for (const inbox of rows) {
    await pollOneInbox(db, config, inbox);
  }
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export async function startImapPollWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("IMAP poll worker not started — DATABASE_URL not set");
    return async () => {};
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("IMAP poll worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  // Register the repeatable 5-minute poll job
  await scheduleImapPolling(config);

  const worker = new Worker<ImapPollJobPayload>(
    IMAP_POLL_QUEUE,
    async (job) => {
      log.info("imap:poll-all started", { attempt: job.attemptsMade });
      await pollInboxes(db, config, job.data);
    },
    {
      connection: redisConnection(config.REDIS_URL),
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("imap:poll job failed", err, { jobId: job?.id });
  });

  log.info("IMAP poll worker started", { queue: IMAP_POLL_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

/** Standalone entrypoint: `node dist/workers/imap-poll.worker.js` */
async function main() {
  const config = loadEnv();
  const stop = await startImapPollWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("imap-poll.worker") ||
  process.env.IMAP_POLL_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
