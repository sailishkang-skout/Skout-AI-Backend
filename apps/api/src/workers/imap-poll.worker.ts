import { Worker } from "bullmq";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { decryptSecret } from "@skout/shared";
import { ingestInboundMessage } from "../services/inbound-reply.service.js";
import { IMAP_POLL_QUEUE, scheduleImapPolling, type ImapPollJobPayload } from "./imap-poll.queue.js";
import { isRedisAvailable } from "../lib/redis.js";

const log = createLogger("imap-poll.worker");

const { inboxes } = schema;

type DbClient = ReturnType<typeof createDb>["db"];

function defaultImapHost(provider: string | null): { host: string; port: number } | null {
  if (provider === "google") return { host: "imap.gmail.com", port: 993 };
  if (provider === "microsoft") return { host: "outlook.office365.com", port: 993 };
  return null;
}

async function pollOneInbox(
  db: DbClient,
  config: Env,
  inbox: typeof inboxes.$inferSelect
): Promise<void> {
  const oauthReady =
    (inbox.provider === "google" || inbox.provider === "microsoft") &&
    !!inbox.oauthAccessTokenEncrypted;
  const passwordReady = !!inbox.smtpPasswordEncrypted && !!inbox.smtpUsername;

  const defaults = defaultImapHost(inbox.provider);
  const imapHost = inbox.imapHost ?? defaults?.host ?? null;
  const imapPort = inbox.imapPort ?? defaults?.port ?? 993;

  if (!imapHost || (!oauthReady && !passwordReady)) {
    return;
  }

  const encryptionKey = config.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    log.warn("INTEGRATION_ENCRYPTION_KEY not configured — skipping IMAP poll", {
      inboxId: inbox.id,
    });
    return;
  }

  let auth: { user: string; pass: string } | { user: string; accessToken: string };
  if (oauthReady) {
    const { resolveAccessToken } = await import("../services/inbox-oauth.service.js");
    const accessToken = await resolveAccessToken(inbox, db, config);
    auth = { user: inbox.emailAddress, accessToken };
  } else {
    const password = decryptSecret(inbox.smtpPasswordEncrypted!, encryptionKey);
    auth = { user: inbox.smtpUsername!, pass: password };
  }

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: true,
    auth,
    logger: false,
  });

  try {
    await client.connect();

    const lock = await client.getMailboxLock("INBOX");
    try {
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

      log.info("IMAP poll complete", { inboxId: inbox.id, newMessages: count, oauth: oauthReady });
    } finally {
      lock.release();
    }

    await db
      .update(inboxes)
      .set({
        imapLastPolledAt: new Date(),
        updatedAt: new Date(),
        // Persist discovered defaults so subsequent polls skip host resolution.
        ...(inbox.imapHost ? {} : { imapHost, imapPort }),
      })
      .where(eq(inboxes.id, inbox.id));
  } catch (err) {
    log.error("IMAP connection failed", err as Error, { inboxId: inbox.id, host: imapHost });
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore logout errors
    }
  }
}

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
        .where(
          and(
            eq(inboxes.status, "active"),
            or(
              isNotNull(inboxes.imapHost),
              eq(inboxes.provider, "google"),
              eq(inboxes.provider, "microsoft")
            )
          )
        );

  for (const inbox of rows) {
    try {
      await pollOneInbox(db, config, inbox);
    } catch (err) {
      log.error("IMAP poll failed for inbox — continuing with remaining inboxes", {
        inboxId: inbox.id,
        err,
      });
    }
  }
}

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
