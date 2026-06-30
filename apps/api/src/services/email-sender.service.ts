import nodemailer from "nodemailer";
import type { Env } from "../config/env.js";
import { decryptSecret } from "../utils/integration-crypto.js";

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

/** Builds a nodemailer-backed transport for a connected inbox's stored SMTP credentials. */
export function buildEmailSenderFromInbox(config: Env, inbox: InboxSmtpConfig): EmailTransport {
  if (!inbox.smtpHost || !inbox.smtpPort || !inbox.smtpUsername || !inbox.smtpPasswordEncrypted) {
    throw new Error("inbox_missing_smtp_credentials");
  }
  const encryptionKey = config.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY not configured — cannot decrypt SMTP credentials");
  }
  const password = decryptSecret(inbox.smtpPasswordEncrypted, encryptionKey);

  const transporter = nodemailer.createTransport({
    host: inbox.smtpHost,
    port: inbox.smtpPort,
    secure: inbox.smtpSecure,
    auth: { user: inbox.smtpUsername, pass: password },
  });

  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      const info = await transporter.sendMail({
        from: input.fromName ? `"${input.fromName}" <${input.from}>` : input.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
      return { externalId: info.messageId };
    },
  };
}
