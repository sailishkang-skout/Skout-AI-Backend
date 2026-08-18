import nodemailer from "nodemailer";
import type { Env } from "../config/env.js";

export interface SendMeetingInviteInput {
  to: string;
  subject: string;
  text: string;
  icsContent: string;
  method: "REQUEST" | "CANCEL";
}

/**
 * Third, isolated mail channel per docs/email-sending-architecture.md — own SMTP credentials,
 * own sending domain, no dependency on apps/api's email-sender.service.ts or the `inboxes`
 * table. Used only for calendar invites, never transactional or outreach mail.
 */
export async function sendMeetingInviteEmail(
  config: Env,
  input: SendMeetingInviteInput
): Promise<{ messageId: string }> {
  if (
    !config.MEETING_INVITE_SMTP_HOST ||
    !config.MEETING_INVITE_SMTP_PORT ||
    !config.MEETING_INVITE_SMTP_USER ||
    !config.MEETING_INVITE_SMTP_PASSWORD ||
    !config.MEETING_INVITE_FROM_ADDRESS
  ) {
    throw new Error("meeting_invite_mail_not_configured");
  }

  const transport = nodemailer.createTransport({
    host: config.MEETING_INVITE_SMTP_HOST,
    port: config.MEETING_INVITE_SMTP_PORT,
    secure: config.MEETING_INVITE_SMTP_PORT === 465,
    auth: { user: config.MEETING_INVITE_SMTP_USER, pass: config.MEETING_INVITE_SMTP_PASSWORD },
  });

  const result = await transport.sendMail({
    from: config.MEETING_INVITE_FROM_ADDRESS,
    to: input.to,
    subject: input.subject,
    text: input.text,
    icalEvent: {
      method: input.method,
      content: input.icsContent,
    },
  });

  return { messageId: result.messageId };
}
