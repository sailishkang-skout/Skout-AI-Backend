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
      requireTLS: config.SMTP_PORT === 587,
      ...(config.SMTP_USERNAME
        ? { auth: { user: config.SMTP_USERNAME, pass: config.SMTP_PASSWORD } }
        : {}),
    });
  }
  return _transport;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fromAddress(config: Env): string {
  const email = (config.SES_FROM_EMAIL || "noreply@skoutai.io").trim();
  // Prefer a friendly display name in clients; SES still validates the address.
  if (email.includes("<")) return email;
  return `Skout AI <${email}>`;
}

function renderTransactionalLayout(opts: {
  preheader: string;
  title: string;
  bodyHtml: string;
  footerNote?: string;
}): string {
  const preheader = escapeHtml(opts.preheader);
  const title = escapeHtml(opts.title);
  const footer =
    opts.footerNote ??
    "You're receiving this because of an action on your Skout AI workspace.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:20px 28px;background:#09090b;color:#fafafa;">
              <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.7;margin-bottom:6px;">Skout AI</div>
              <div style="font-size:20px;font-weight:700;line-height:1.3;">${title}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-size:15px;line-height:1.6;color:#27272a;">
              ${opts.bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 24px;border-top:1px solid #f4f4f5;font-size:12px;line-height:1.5;color:#71717a;">
              ${escapeHtml(footer)}
            </td>
          </tr>
        </table>
        <div style="max-width:560px;margin-top:16px;font-size:11px;color:#a1a1aa;text-align:center;">
          © ${new Date().getUTCFullYear()} Skout AI
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;background:#09090b;color:#fafafa;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
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

  const from = fromAddress(config);

  try {
    const info = await transport.sendMail({
      from,
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
      from,
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
  const inviter = escapeHtml(opts.inviterName);
  const workspace = escapeHtml(opts.workspaceName);
  const role = escapeHtml(opts.role);

  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi,</p>
    <p style="margin:0 0 16px;"><strong>${inviter}</strong> invited you to join <strong>${workspace}</strong> on Skout AI as a <strong>${role}</strong>.</p>
    <p style="margin:0 0 24px;">Accept the invitation to access prospects, sequences, and inbox with your team.</p>
    <p style="margin:0 0 8px;">${ctaButton(opts.acceptUrl, "Accept invitation")}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#71717a;word-break:break-all;">Or paste this link into your browser:<br /><a href="${escapeHtml(opts.acceptUrl)}" style="color:#3f3f46;">${escapeHtml(opts.acceptUrl)}</a></p>
    <p style="margin:20px 0 0;font-size:12px;color:#71717a;">This link expires in 7 days. If you weren't expecting this email, you can ignore it.</p>
  `;

  return {
    to: opts.to,
    subject: `Join ${opts.workspaceName} on Skout AI`,
    text: [
      `${opts.inviterName} invited you to join "${opts.workspaceName}" as a ${opts.role}.`,
      "",
      `Accept your invitation: ${opts.acceptUrl}`,
      "",
      "This link expires in 7 days.",
      "If you weren't expecting this email, you can ignore it.",
    ].join("\n"),
    html: renderTransactionalLayout({
      preheader: `${opts.inviterName} invited you to ${opts.workspaceName}`,
      title: "You're invited",
      bodyHtml,
    }),
  };
}

export function buildOtpEmail(opts: {
  to: string;
  otp: string;
  workspaceName: string;
  expiresInMinutes: number;
}): MailOptions {
  const workspace = escapeHtml(opts.workspaceName);
  const otp = escapeHtml(opts.otp);

  const bodyHtml = `
    <p style="margin:0 0 16px;">Use this code to join <strong>${workspace}</strong> on Skout AI:</p>
    <div style="margin:8px 0 24px;text-align:center;">
      <div style="display:inline-block;padding:16px 28px;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;font-size:32px;font-weight:700;letter-spacing:0.35em;color:#09090b;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
        ${otp}
      </div>
    </div>
    <p style="margin:0;font-size:13px;color:#71717a;">Expires in ${opts.expiresInMinutes} minutes. Never share this code with anyone.</p>
  `;

  return {
    to: opts.to,
    subject: `Your Skout AI code: ${opts.otp}`,
    text: [
      `Your Skout verification code is: ${opts.otp}`,
      "",
      `This code expires in ${opts.expiresInMinutes} minutes.`,
      "Do not share this code with anyone.",
    ].join("\n"),
    html: renderTransactionalLayout({
      preheader: `Your verification code is ${opts.otp}`,
      title: "Verification code",
      bodyHtml,
      footerNote: "If you didn't request this code, you can safely ignore this email.",
    }),
  };
}
