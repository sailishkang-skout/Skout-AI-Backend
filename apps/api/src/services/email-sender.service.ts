import nodemailer, { type Transporter } from "nodemailer";
import type { Db } from "@skout/db";
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
  /** RFC Message-ID for threading (optional). */
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

export interface SendEmailResult {
  externalId: string;
}

export interface EmailTransport {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/** SMTP password path (legacy). */
export interface InboxSmtpConfig {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUsername: string | null;
  smtpPasswordEncrypted: string | null;
  smtpSecure: boolean;
}

/** Full inbox row fields needed for SMTP password or OAuth2 send. */
export interface InboxSendConfig extends InboxSmtpConfig {
  id?: string;
  emailAddress?: string;
  provider?: string | null;
  oauthAccessTokenEncrypted?: string | null;
  oauthRefreshTokenEncrypted?: string | null;
  oauthTokenExpiresAt?: Date | null;
}

const transporterCache = new Map<string, Transporter>();

function smtpCacheKey(inbox: InboxSmtpConfig): string {
  return `smtp:${inbox.smtpHost}:${inbox.smtpPort}:${inbox.smtpUsername}`;
}

function oauthCacheKey(inbox: InboxSendConfig, accessToken: string): string {
  return `oauth:${inbox.provider}:${inbox.emailAddress}:${accessToken.slice(0, 12)}`;
}

function wrapTransporter(transporter: Transporter): EmailTransport {
  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      try {
        const info = await transporter.sendMail({
          from: input.fromName ? `"${input.fromName}" <${input.from}>` : input.from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
          ...(input.references ? { references: input.references } : {}),
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

function buildSmtpPasswordTransport(config: Env, inbox: InboxSmtpConfig): EmailTransport {
  if (!inbox.smtpHost || !inbox.smtpPort || !inbox.smtpUsername || !inbox.smtpPasswordEncrypted) {
    throw new Error("inbox_missing_smtp_credentials");
  }
  const encryptionKey = config.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY not configured — cannot decrypt SMTP credentials");
  }

  const cacheKey = smtpCacheKey(inbox);
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

  return wrapTransporter(transporter);
}

async function buildOAuthTransport(
  config: Env,
  inbox: InboxSendConfig,
  db: Db
): Promise<EmailTransport> {
  if (!inbox.id || !inbox.emailAddress) {
    throw new Error("inbox_oauth_missing_identity");
  }
  const { resolveAccessToken } = await import("./inbox-oauth.service.js");
  // resolveAccessToken expects a full inbox row — pass through known fields.
  const accessToken = await resolveAccessToken(inbox as Parameters<typeof resolveAccessToken>[0], db, config);

  const smtpConfig =
    inbox.provider === "google"
      ? { host: "smtp.gmail.com", port: 465, secure: true }
      : { host: "smtp.office365.com", port: 587, secure: false };

  const clientId =
    inbox.provider === "google" ? config.GOOGLE_CLIENT_ID : config.MICROSOFT_CLIENT_ID;
  const clientSecret =
    inbox.provider === "google" ? config.GOOGLE_CLIENT_SECRET : config.MICROSOFT_CLIENT_SECRET;

  const cacheKey = oauthCacheKey(inbox, accessToken);
  let transporter = transporterCache.get(cacheKey);
  if (!transporter) {
    transporter = nodemailer.createTransport({
      ...smtpConfig,
      auth: {
        type: "OAuth2",
        user: inbox.emailAddress,
        clientId,
        clientSecret,
        accessToken,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 5_000,
      socketTimeout: 30_000,
    });
    transporterCache.set(cacheKey, transporter);
  }

  return wrapTransporter(transporter);
}

export function inboxSupportsOAuthSend(inbox: InboxSendConfig): boolean {
  return (
    (inbox.provider === "google" || inbox.provider === "microsoft") &&
    !!inbox.oauthAccessTokenEncrypted
  );
}

/**
 * Builds a nodemailer transport for SMTP password **or** Google/Microsoft OAuth2.
 * Pass `db` whenever the inbox may be OAuth — required to refresh tokens.
 */
export async function buildEmailSenderFromInbox(
  config: Env,
  inbox: InboxSendConfig,
  db?: Db
): Promise<EmailTransport> {
  if (inboxSupportsOAuthSend(inbox)) {
    if (!db) {
      throw new Error("inbox_oauth_requires_db");
    }
    return buildOAuthTransport(config, inbox, db);
  }
  return buildSmtpPasswordTransport(config, inbox);
}

/** @deprecated Prefer async `buildEmailSenderFromInbox` — sync SMTP-only helper for tests. */
export function buildSmtpEmailSenderFromInbox(config: Env, inbox: InboxSmtpConfig): EmailTransport {
  return buildSmtpPasswordTransport(config, inbox);
}

/** Clear transporter cache (tests). */
export function clearEmailTransporterCache(): void {
  transporterCache.clear();
}
