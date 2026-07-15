import nodemailer from "nodemailer";
import type { Env } from "../config/env.js";

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
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

export async function sendMail(config: Env, opts: MailOptions): Promise<void> {
  const transport = getTransport(config);
  if (!transport) {
    console.warn(`[MAIL] SMTP_HOST not set — email NOT sent. To: ${opts.to} | ${opts.subject}`);
    return;
  }

  const actualTo = config.MAIL_REDIRECT_TO ?? opts.to;
  if (config.MAIL_REDIRECT_TO) {
    console.log(`[MAIL] ⚠️  REDIRECT: ${opts.to} → ${config.MAIL_REDIRECT_TO}`);
  }
  console.log(`[MAIL] Sending → From: ${config.SES_FROM_EMAIL} | To: ${actualTo} | Subject: ${opts.subject}`);
  console.log(`[MAIL] SMTP Host: ${config.SMTP_HOST}:${config.SMTP_PORT}`);

  try {
    const info = await transport.sendMail({
      from: config.SES_FROM_EMAIL,
      to: actualTo,
      subject: opts.subject,
      text: config.MAIL_REDIRECT_TO ? `[DEV REDIRECT — original to: ${opts.to}]\n\n${opts.text}` : opts.text,
      html: config.MAIL_REDIRECT_TO
        ? `<p style="background:#fef3c7;padding:8px;border-radius:4px;font-size:12px">⚠️ DEV REDIRECT — original to: <strong>${opts.to}</strong></p>${opts.html}`
        : opts.html,
    });
    console.log(`[MAIL] ✅ Sent successfully | MessageId: ${info.messageId} | Response: ${info.response}`);
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string; response?: string; responseCode?: number };
    console.error(`[MAIL] ❌ Failed to send email`);
    console.error(`[MAIL]    To:           ${opts.to}`);
    console.error(`[MAIL]    From:         ${config.SES_FROM_EMAIL}`);
    console.error(`[MAIL]    SMTP:         ${config.SMTP_HOST}:${config.SMTP_PORT}`);
    console.error(`[MAIL]    Error:        ${e.message}`);
    console.error(`[MAIL]    Code:         ${e.code}`);
    console.error(`[MAIL]    SMTP Code:    ${e.responseCode}`);
    console.error(`[MAIL]    SMTP Response:${e.response}`);
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
