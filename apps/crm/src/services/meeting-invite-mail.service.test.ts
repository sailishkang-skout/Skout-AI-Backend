import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn().mockReturnValue({ sendMail });

vi.mock("nodemailer", () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
}));

import { sendMeetingInviteEmail } from "./meeting-invite-mail.service.js";
import type { Env } from "../config/env.js";

const config = {
  MEETING_INVITE_SMTP_HOST: "smtp.invites-test.com",
  MEETING_INVITE_SMTP_PORT: 587,
  MEETING_INVITE_SMTP_USER: "invites@mail.skout.ai",
  MEETING_INVITE_SMTP_PASSWORD: "test-password",
  MEETING_INVITE_FROM_ADDRESS: "invites@mail.skout.ai",
} as unknown as Env;

describe("sendMeetingInviteEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTransport.mockReturnValue({ sendMail });
  });

  it("throws when SMTP is not configured", async () => {
    await expect(
      sendMeetingInviteEmail({} as Env, {
        to: "prospect@acme.com",
        subject: "Invite",
        text: "See attached",
        icsContent: "BEGIN:VCALENDAR...",
        method: "REQUEST",
      })
    ).rejects.toThrow("meeting_invite_mail_not_configured");
  });

  it("sends with the ics content as a calendar attachment", async () => {
    sendMail.mockResolvedValue({ messageId: "msg-1" });
    const result = await sendMeetingInviteEmail(config, {
      to: "prospect@acme.com",
      subject: "Invite: Intro call",
      text: "See attached calendar invite.",
      icsContent: "BEGIN:VCALENDAR\nEND:VCALENDAR",
      method: "REQUEST",
    });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.invites-test.com", port: 587 })
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "invites@mail.skout.ai",
        to: "prospect@acme.com",
        subject: "Invite: Intro call",
        icalEvent: expect.objectContaining({
          method: "REQUEST",
          content: "BEGIN:VCALENDAR\nEND:VCALENDAR",
        }),
      })
    );
    expect(result).toEqual({ messageId: "msg-1" });
  });
});
