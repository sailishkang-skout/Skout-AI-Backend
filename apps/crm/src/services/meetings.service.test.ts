import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./meeting-invite-mail.service.js", () => ({
  sendMeetingInviteEmail: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
}));
vi.mock("./skout-event.service.js", () => ({
  emitSkoutEvent: vi.fn(async (_config: unknown, input: unknown) => ({ id: "evt-1", ...(input as object) })),
}));

import { sendMeetingInviteEmail } from "./meeting-invite-mail.service.js";
import { emitSkoutEvent } from "./skout-event.service.js";
import { MeetingsService } from "./meetings.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}
function insertConflictNothing() {
  return { values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) };
}
function selectAutoJoin(enabled: boolean) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ meetingBotAutoJoinDefault: enabled }]) }),
    }),
  };
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
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce(insertReturning([meetingRow]))
        .mockReturnValueOnce(insertConflictNothing()),
    };
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
      select: vi.fn().mockReturnValue(selectAutoJoin(false)),
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
    const tx = {
      insert: vi.fn().mockReturnValueOnce(insertReturning([meetingRow])),
    };
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
      select: vi.fn().mockReturnValue(selectAutoJoin(false)),
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
    expect(tx.insert).toHaveBeenCalledTimes(1); // only the meeting row, no attendees insert
  });

  it("dedupes case-insensitively duplicate invitee emails before inserting attendees", async () => {
    const meetingRow = {
      id: "meeting-3",
      workspaceId: "ws-1",
      contactId: null,
      companyId: null,
      dealId: null,
      organizerId: "user-1",
      title: "Dup invitees",
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
      icsUid: "generated-uid-2@meetings.skout.ai",
      icsSequence: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const attendeesInsert = insertConflictNothing();
    const tx = {
      insert: vi.fn().mockReturnValueOnce(insertReturning([meetingRow])).mockReturnValueOnce(attendeesInsert),
    };
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
      select: vi.fn().mockReturnValue(selectAutoJoin(false)),
    };
    const activitiesService = { record: vi.fn() };
    const config = { MEETING_INVITE_SMTP_HOST: "smtp.test.com" } as any;

    const svc = new MeetingsService(db as any, activitiesService as any, config);
    await svc.create("ws-1", "user-1", {
      title: "Dup invitees",
      scheduledAt: "2026-09-01T15:00:00.000Z",
      durationMinutes: 30,
      meetingType: "video",
      invitees: [{ email: "Prospect@acme.com" }, { email: "prospect@acme.com" }],
    } as any);

    expect(attendeesInsert.values).toHaveBeenCalledWith([{ meetingId: "meeting-3", email: "prospect@acme.com" }]);
    expect(sendMeetingInviteEmail).toHaveBeenCalledTimes(1);
  });

  it("skips the ICS invite entirely when sendIcsInvites is false (e.g. destined for /schedule-google)", async () => {
    const meetingRow = {
      id: "meeting-4",
      workspaceId: "ws-1",
      contactId: null,
      companyId: null,
      dealId: null,
      organizerId: "user-1",
      title: "Google-scheduled meeting",
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
      invitees: [{ email: "prospect@acme.com" }],
      googleEventId: null,
      icsUid: null,
      icsSequence: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const tx = { insert: vi.fn().mockReturnValueOnce(insertReturning([meetingRow])) };
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
      select: vi.fn().mockReturnValue(selectAutoJoin(false)),
    };
    const activitiesService = { record: vi.fn() };
    const config = { MEETING_INVITE_SMTP_HOST: "smtp.test.com" } as any;

    const svc = new MeetingsService(db as any, activitiesService as any, config);
    const dto = await svc.create("ws-1", "user-1", {
      title: "Google-scheduled meeting",
      scheduledAt: "2026-09-01T15:00:00.000Z",
      durationMinutes: 30,
      meetingType: "video",
      invitees: [{ email: "prospect@acme.com" }],
      sendIcsInvites: false,
    } as any);

    expect(dto.icsUid).toBeNull();
    expect(sendMeetingInviteEmail).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalledTimes(1); // only the meeting row, no attendees insert
  });
});

describe("MeetingsService.update — event spine", () => {
  const EXISTING_ROW = {
    id: "meeting-1",
    workspaceId: "ws-1",
    contactId: "contact-1",
    companyId: "company-1",
    dealId: "deal-1",
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
    icsUid: null,
    icsSequence: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  function makeUpdateDb(updatedRow: Record<string, unknown>) {
    let selectCall = 0;
    return {
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([EXISTING_ROW]) }) }) };
        }
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) };
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updatedRow]) }) }),
      }),
    };
  }

  it("emits meeting.completed when an outcome is recorded", async () => {
    const updatedRow = { ...EXISTING_ROW, outcome: "held" };
    const db = makeUpdateDb(updatedRow);
    const svc = new MeetingsService(db as any, { record: vi.fn() } as any, { MEETING_INVITE_SMTP_HOST: "smtp.test.com" } as any);

    await svc.update("ws-1", "meeting-1", { outcome: "held" } as any);

    expect(emitSkoutEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "meeting.completed",
        tenantId: "ws-1",
        aggregateId: "meeting-1",
        data: expect.objectContaining({ outcome: "held", contactId: "contact-1", dealId: "deal-1" }),
      })
    );
  });

  it("does not emit meeting.completed for an update that doesn't touch outcome", async () => {
    const updatedRow = { ...EXISTING_ROW, title: "Renamed call" };
    const db = makeUpdateDb(updatedRow);
    const svc = new MeetingsService(db as any, { record: vi.fn() } as any, { MEETING_INVITE_SMTP_HOST: "smtp.test.com" } as any);

    await svc.update("ws-1", "meeting-1", { title: "Renamed call" } as any);

    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });
});
