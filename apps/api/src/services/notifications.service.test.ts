import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../config/env.js";

vi.mock("./mail.service.js", () => ({
  sendMail: vi.fn(async () => ({ sent: false })),
}));

vi.mock("./telecom.service.js", () => ({
  isSmsConfigured: vi.fn(() => true),
  sendSms: vi.fn(async () => ({ messageSid: "SM123", status: "queued" })),
}));

import { sendMail } from "./mail.service.js";
import { isSmsConfigured, sendSms } from "./telecom.service.js";
import { createNotification } from "./notifications.service.js";

const fakeConfig = {} as Env;

interface DbMockOpts {
  preference?: { channel: string; digest: boolean } | null;
  userPhone?: string | null;
  slackWebhookUrl?: string | null;
}

function makeDb({ preference = null, userPhone = null, slackWebhookUrl = null }: DbMockOpts = {}) {
  const insertReturning = vi.fn().mockResolvedValue([
    {
      id: "notif-1",
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
      body: null,
      entityType: "meeting",
      entityId: "m-1",
      deliveredChannels: ["in_app"],
      readAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });

  // Each db.select(...).from(...).where(...).limit(1) call resolves in call order:
  //  1) resolvePreference's "specific" lookup
  //  2) sms branch's user phone lookup (only reached when channel === "sms")
  //  3) deliverSlack's workspace lookup
  const limit = vi
    .fn()
    .mockResolvedValueOnce(preference ? [preference] : [])
    .mockResolvedValueOnce(userPhone !== null ? [{ phone: userPhone }] : [])
    .mockResolvedValueOnce(slackWebhookUrl !== null ? [{ slackWebhookUrl }] : [{ slackWebhookUrl: null }]);

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit,
  };

  const updateWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });

  return {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    _updateSet: updateSet,
  } as any;
}

describe("createNotification — sms delivery", () => {
  beforeEach(() => {
    vi.mocked(sendMail).mockClear();
    vi.mocked(sendSms).mockClear();
    vi.mocked(isSmsConfigured).mockClear().mockReturnValue(true);
  });

  it("sends an SMS and records the sms channel when the user's preference is sms", async () => {
    const db = makeDb({ preference: { channel: "sms", digest: false }, userPhone: "+14155551234" });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
      body: "Starts in an hour",
      entityType: "meeting",
      entityId: "m-1",
    });

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledWith(fakeConfig, {
      to: "+14155551234",
      body: "Meeting soon\nStarts in an hour",
    });
    expect(result.deliveredChannels).toContain("sms");
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredChannels: expect.arrayContaining(["in_app", "sms"]) })
    );
  });

  it("does not send an SMS when the user has no phone number on file", async () => {
    const db = makeDb({ preference: { channel: "sms", digest: false }, userPhone: null });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(result.deliveredChannels).not.toContain("sms");
  });

  it("does not send an SMS when telecom isn't configured", async () => {
    vi.mocked(isSmsConfigured).mockReturnValue(false);
    const db = makeDb({ preference: { channel: "sms", digest: false }, userPhone: "+14155551234" });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(result.deliveredChannels).not.toContain("sms");
  });

  it("does not send an SMS for a digest-preferring user", async () => {
    const db = makeDb({ preference: { channel: "sms", digest: true }, userPhone: "+14155551234" });

    await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
    });

    expect(sendSms).not.toHaveBeenCalled();
  });

  it("swallows sendSms failures without throwing", async () => {
    vi.mocked(sendSms).mockRejectedValueOnce(new Error("Twilio down"));
    const db = makeDb({ preference: { channel: "sms", digest: false }, userPhone: "+14155551234" });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
    });

    expect(result).toBeTruthy();
    expect(result.deliveredChannels).not.toContain("sms");
  });

  it("does not attempt sms delivery for the email channel", async () => {
    const db = makeDb({ preference: { channel: "email", digest: false }, userPhone: "+14155551234" });

    await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
    });

    expect(sendSms).not.toHaveBeenCalled();
  });
});
