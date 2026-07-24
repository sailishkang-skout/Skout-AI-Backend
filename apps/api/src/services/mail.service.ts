import nodemailer from "nodemailer";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";

const log = createLogger("mail.service");

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendMailResult {
  /** True when SMTP accepted the message. False when SMTP is not configured. */
  sent: boolean;
  messageId?: string;
}

let _transport: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransport(config: Env): ReturnType<typeof nodemailer.createTransport> | null {
  if (!config.SMTP_HOST) return null;
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      ...(config.SMTP_USERNAME
        ? { auth: { user: config.SMTP_USERNAME, pass: config.SMTP_PASSWORD } }
        : {}),
    });
  }
  return _transport;
}

/**
 * Sends a transactional email via SES SMTP when configured.
 * Returns `{ sent: false }` (no throw) when SMTP_HOST is unset so callers can
 * still return invite/OTP payloads and surface a copyable link in the UI.
 * Throws when SMTP is configured but delivery fails.
 */
export async function sendMail(config: Env, opts: MailOptions): Promise<SendMailResult> {
  const transport = getTransport(config);
  if (!transport) {
    log.warn("SMTP_HOST not set — email not sent", { to: opts.to, subject: opts.subject });
    return { sent: false };
  }

  // Placeholder credentials from CDK — treat as unconfigured so invites still succeed.
  if (
    !config.SMTP_USERNAME ||
    config.SMTP_USERNAME === "replace-me" ||
    !config.SMTP_PASSWORD ||
    config.SMTP_PASSWORD === "replace-me"
  ) {
    log.warn("SMTP credentials not configured — email not sent", {
      to: opts.to,
      subject: opts.subject,
    });
    return { sent: false };
  }

  try {
    const info = await transport.sendMail({
      from: config.SES_FROM_EMAIL,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    log.info("system email sent", {
      to: opts.to,
      subject: opts.subject,
      messageId: info.messageId,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string; response?: string; responseCode?: number };
    log.error("system email failed", err, {
      to: opts.to,
      from: config.SES_FROM_EMAIL,
      smtpHost: config.SMTP_HOST,
      smtpPort: config.SMTP_PORT,
      code: e.code,
      responseCode: e.responseCode,
    });
    throw err;
  }
}

export function buildInviteEmail(opts: {
  to: string;
  inviterName: string;
  workspaceName: string;
  role: string;
  acceptUrl: string;
}): MailOptions {
  return {
    to: opts.to,
    subject: `You've been invited to join ${opts.workspaceName} on Skout`,
    text: [
      `${opts.inviterName} has invited you to join "${opts.workspaceName}" as a ${opts.role}.`,
      "",
      `Accept your invitation: ${opts.acceptUrl}`,
      "",
      "This link expires in 7 days.",
    ].join("\n"),
    html: `
      <p>${opts.inviterName} has invited you to join <strong>${opts.workspaceName}</strong> as a <strong>${opts.role}</strong>.</p>
      <p><a href="${opts.acceptUrl}" style="display:inline-block;padding:10px 20px;background:#000;color:#fff;text-decoration:none;border-radius:6px">Accept invitation</a></p>
      <p style="color:#888;font-size:13px">This link expires in 7 days. If you weren't expecting this, you can ignore it.</p>
    `,
  };
}

export function buildOtpEmail(opts: {
  to: string;
  otp: string;
  workspaceName: string;
  expiresInMinutes: number;
}): MailOptions {
  return {
    to: opts.to,
    subject: `Your verification code for ${opts.workspaceName} — ${opts.otp}`,
    text: [
      `Your Skout verification code is: ${opts.otp}`,
      "",
      `This code expires in ${opts.expiresInMinutes} minutes.`,
      "Do not share this code with anyone.",
    ].join("\n"),
    html: `
      <p style="font-size:15px">Enter this code to join <strong>${opts.workspaceName}</strong> on Skout:</p>
      <div style="margin:24px 0;text-align:center">
        <span style="display:inline-block;padding:16px 32px;background:#000;color:#fff;font-size:32px;font-weight:700;letter-spacing:8px;border-radius:8px">${opts.otp}</span>
      </div>
      <p style="color:#888;font-size:13px">Expires in ${opts.expiresInMinutes} minutes. Never share this code.</p>
    `,
  };
}
