import type { Env } from "../config/env.js";

interface InviteEmailOptions {
  to: string;
  inviterName: string;
  workspaceName: string;
  role: string;
  acceptUrl: string;
}

export function createTransactionalMailer(config: Env) {
  const baseUrl = config.INVITE_BASE_URL ?? config.FRONTEND_URL ?? "http://localhost:3000";

  async function sendInviteEmail(opts: InviteEmailOptions): Promise<void> {
    if (!config.INVITE_SMTP_HOST) {
      console.warn(
        `[INVITE] INVITE_SMTP_HOST not set — email NOT sent. To: ${opts.to}, URL: ${opts.acceptUrl}`
      );
      return;
    }

    const nodemailer = await import("nodemailer");
    const port = config.INVITE_SMTP_PORT ?? 587;
    const transport = nodemailer.default.createTransport({
      host: config.INVITE_SMTP_HOST,
      port,
      secure: port === 465,
      ...(config.INVITE_SMTP_USER
        ? { auth: { user: config.INVITE_SMTP_USER, pass: config.INVITE_SMTP_PASS } }
        : {}),
    });

    await transport.sendMail({
      from: config.INVITE_FROM_EMAIL,
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
    });
  }

  return { sendInviteEmail, baseUrl };
}
