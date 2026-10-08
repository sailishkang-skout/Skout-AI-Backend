import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../config/env.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("@skout/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skout/observability")>();
  return { ...actual, captureException: captureExceptionMock };
});

vi.mock("./mail.service.js", () => ({
  sendMail: vi.fn(async () => ({ sent: false })),
}));

vi.mock("./telecom.service.js", () => ({
  isSmsConfigured: vi.fn(() => true),
  sendSms: vi.fn(async () => ({ messageSid: "SM123", status: "queued" })),
}));

import { sendMail } from "./mail.service.js";
import { isSmsConfigured, sendSms } from "./telecom.service.js";
import { captureException } from "@skout/observability";
import {
  createNotification,
  deliverNotificationChannels,
  retryNotificationDelivery,
} from "./notifications.service.js";

const fakeConfig = {} as Env;

interface DbMockOpts {
  preference?: { channel: string; digest: boolean } | null;
  userPhone?: string | null;
  slackWebhookUrl?: string | null;
  teamsWebhookUrl?: string | null;
}

function makeDb({
  preference = null,
  userPhone = null,
  slackWebhookUrl = null,
  teamsWebhookUrl = null,
}: DbMockOpts = {}) {
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

  let selectedRows: unknown[] = [];
  const limit = vi.fn().mockImplementation(async () => selectedRows);

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit,
  };
  const select = vi.fn((fields?: Record<string, unknown>) => {
    if (fields && "phone" in fields) {
      selectedRows = userPhone !== null ? [{ phone: userPhone }] : [];
    } else if (fields && "teamsWebhookUrl" in fields) {
      selectedRows = [{ teamsWebhookUrl }];
    } else if (fields && "slackWebhookUrl" in fields) {
      selectedRows = [{ slackWebhookUrl }];
    } else {
      selectedRows = preference ? [preference] : [];
    }
    return selectChain;
  });

  const updateWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });

  return {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    select,
    update: vi.fn().mockReturnValue({ set: updateSet }),
    _updateSet: updateSet,
  } as any;
}

describe("createNotification — sms delivery", () => {
  beforeEach(() => {
    vi.mocked(captureException).mockClear();
    vi.mocked(sendMail).mockClear();
    vi.mocked(sendSms).mockClear();
    vi.mocked(isSmsConfigured).mockClear().mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("retries an SMS provider failure and keeps the in-app record", async () => {
    vi.mocked(sendSms).mockRejectedValueOnce(new Error("Twilio down"));
    const db = makeDb({ preference: { channel: "sms", digest: false }, userPhone: "+14155551234" });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
    });

    expect(result).toBeTruthy();
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(result.deliveredChannels).toContain("sms");
  });

  it("does not fail notification creation when the SMS provider exhausts retries", async () => {
    vi.mocked(sendSms).mockRejectedValue(new Error("Twilio unavailable"));
    const db = makeDb({ preference: { channel: "sms", digest: false }, userPhone: "+14155551234" });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "meeting_reminder",
      title: "Meeting soon",
    });

    expect(sendSms).toHaveBeenCalledTimes(3);
    expect(result.deliveredChannels).toContain("in_app");
    expect(result.deliveredChannels).not.toContain("sms");
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ module: "notifications.service", channel: "sms" })
    );
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

describe("retryNotificationDelivery", () => {
  it("alerts after the retry budget while returning control to the originating operation", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("provider down"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(retryNotificationDelivery("email", { workspaceId: "ws-1" }, deliver, sleep)).resolves.toBeNull();
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });
});

describe("createNotification — Teams delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a text payload to the configured Teams Workflows webhook", async () => {
    const webhookUrl = "https://prod-01.powerplatform.com/workflows/trigger?sig=secret";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const db = makeDb({ teamsWebhookUrl: webhookUrl });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "cops_event",
      title: "Customer activated",
      body: "A customer completed activation.",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Customer activated\nA customer completed activation." }),
        redirect: "error",
      })
    );
    expect(result.deliveredChannels).toContain("teams");
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredChannels: expect.arrayContaining(["in_app", "teams"]) })
    );
  });

  it("keeps in-app notification creation successful after Teams retries are exhausted", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Teams unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const db = makeDb({ teamsWebhookUrl: "https://prod-01.powerplatform.com/workflows/trigger?sig=secret" });

    const result = await createNotification(db, fakeConfig, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "cops_event",
      title: "Customer activated",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.deliveredChannels).toContain("in_app");
    expect(result.deliveredChannels).not.toContain("teams");
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ module: "notifications.service", channel: "teams" })
    );
  });

  it("throws after exhausted Teams retries for an event worker so BullMQ retries the job", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Teams unavailable")));
    const db = makeDb({ teamsWebhookUrl: "https://prod-01.powerplatform.com/workflows/trigger?sig=secret" });

    await expect(
      deliverNotificationChannels(
        db,
        fakeConfig,
        {
          id: "notif-1",
          workspaceId: "ws-1",
          userId: "user-1",
          type: "cops_event",
          title: "Customer activated",
          body: null,
          entityType: "deal",
          entityId: "deal-1",
          deliveredChannels: ["in_app"],
          readAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        { eventId: "event-1" },
        { retryFailedDelivery: true }
      )
    ).rejects.toThrow("Teams notification delivery failed after retries");
  });
});
