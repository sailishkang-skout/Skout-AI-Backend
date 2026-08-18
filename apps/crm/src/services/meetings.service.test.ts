import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./meeting-invite-mail.service.js", () => ({
  sendMeetingInviteEmail: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
}));

import { sendMeetingInviteEmail } from "./meeting-invite-mail.service.js";
import { MeetingsService } from "./meetings.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}
function insertNoReturning() {
  return { values: vi.fn().mockResolvedValue(undefined) };
}

describe("MeetingsService.create — ICS invites", () => {
  it("generates an icsUid, persists attendees, and sends an invite per attendee", async () => {
    const meetingRow = {
      id: "meeting-1",
      workspaceId: "ws-1",
      contactId: null,
      companyId: null,
      dealId: null,
      organizerId: "user-1",
      title: "Intro call",
      scheduledAt: new Date("2026-09-01T15:00:00.000Z"),
      durationMinutes: 30,
      meetingType: "video",
      summary: null,
      outcome: null,
      meetingUrl: null,
      botExternalId: null,
      botStatus: "not_scheduled",
      autoJoinBot: false,
      recordingUrl: null,
      transcriptUrl: null,
      transcript: null,
      invitees: [],
      googleEventId: null,
      icsUid: "generated-uid@meetings.skout.ai",
      icsSequence: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const db = {
      insert: vi
        .fn()
        .mockReturnValueOnce(insertReturning([meetingRow]))
        .mockReturnValueOnce(insertNoReturning()),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ meetingBotAutoJoinDefault: false }]) }),
        }),
      }),
    };
    const activitiesService = { record: vi.fn() };
    const config = { MEETING_INVITE_SMTP_HOST: "smtp.test.com" } as any;

    const svc = new MeetingsService(db as any, activitiesService as any, config);
    const dto = await svc.create("ws-1", "user-1", {
      title: "Intro call",
      scheduledAt: "2026-09-01T15:00:00.000Z",
      durationMinutes: 30,
      meetingType: "video",
      invitees: [{ email: "prospect@acme.com" }],
    } as any);

    expect(dto.icsUid).toBeTruthy();
    expect(sendMeetingInviteEmail).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ to: "prospect@acme.com", method: "REQUEST" })
    );
  });

  it("does not attempt to send invites when there are no invitees", async () => {
    const meetingRow = {
      id: "meeting-2",
      workspaceId: "ws-1",
      contactId: null,
      companyId: null,
      dealId: null,
      organizerId: "user-1",
      title: "Internal sync",
      scheduledAt: new Date("2026-09-01T15:00:00.000Z"),
      durationMinutes: 30,
      meetingType: "call",
      summary: null,
      outcome: null,
      meetingUrl: null,
      botExternalId: null,
      botStatus: "not_scheduled",
      autoJoinBot: false,
      recordingUrl: null,
      transcriptUrl: null,
      transcript: null,
      invitees: [],
      googleEventId: null,
      icsUid: null,
      icsSequence: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const db = {
      insert: vi.fn().mockReturnValueOnce(insertReturning([meetingRow])),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ meetingBotAutoJoinDefault: false }]) }),
        }),
      }),
    };
    const activitiesService = { record: vi.fn() };
    const config = { MEETING_INVITE_SMTP_HOST: "smtp.test.com" } as any;

    const svc = new MeetingsService(db as any, activitiesService as any, config);
    await svc.create("ws-1", "user-1", {
      title: "Internal sync",
      scheduledAt: "2026-09-01T15:00:00.000Z",
      durationMinutes: 30,
      meetingType: "call",
    } as any);

    expect(sendMeetingInviteEmail).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
