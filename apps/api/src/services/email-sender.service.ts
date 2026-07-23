import nodemailer, { type Transporter } from "nodemailer";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { decryptSecret } from "../utils/integration-crypto.js";

const log = createLogger("email-sender.service");

export interface SendEmailInput {
  from: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendEmailResult {
  externalId: string;
}

export interface EmailTransport {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export interface InboxSmtpConfig {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUsername: string | null;
  smtpPasswordEncrypted: string | null;
  smtpSecure: boolean;
}

// Cache transporters by inbox credentials so we reuse the TCP/TLS connection
// instead of opening a new one for every email.
const transporterCache = new Map<string, Transporter>();

function transporterCacheKey(inbox: InboxSmtpConfig): string {
  return `${inbox.smtpHost}:${inbox.smtpPort}:${inbox.smtpUsername}`;
}

/** Builds (or returns a cached) nodemailer transport for a connected inbox. */
export function buildEmailSenderFromInbox(config: Env, inbox: InboxSmtpConfig): EmailTransport {
  if (!inbox.smtpHost || !inbox.smtpPort || !inbox.smtpUsername || !inbox.smtpPasswordEncrypted) {
    throw new Error("inbox_missing_smtp_credentials");
  }
  const encryptionKey = config.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY not configured — cannot decrypt SMTP credentials");
  }

  const cacheKey = transporterCacheKey(inbox);
  let transporter = transporterCache.get(cacheKey);

  if (!transporter) {
    const password = decryptSecret(inbox.smtpPasswordEncrypted, encryptionKey);
    transporter = nodemailer.createTransport({
      host: inbox.smtpHost,
      port: inbox.smtpPort,
      secure: inbox.smtpSecure,
      auth: { user: inbox.smtpUsername, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 5_000,
      socketTimeout: 30_000,
    });
    transporterCache.set(cacheKey, transporter);
  }

  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      try {
        const info = await transporter!.sendMail({
          from: input.fromName ? `"${input.fromName}" <${input.from}>` : input.from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
        log.info("email sent", {
          from: input.from,
          to: input.to,
          externalId: info.messageId ?? "",
        });
        return { externalId: info.messageId ?? "" };
      } catch (err) {
        log.error("email send failed", err, { from: input.from, to: input.to });
        throw err;
      }
    },
  };
}
