import { beforeEach, describe, expect, it, vi } from "vitest";

const { createdNotifications, createNotificationMock } = vi.hoisted(() => {
  const createdNotifications: unknown[] = [];
  const createNotificationMock = vi.fn(async (_db: unknown, _config: unknown, input: unknown) => {
    createdNotifications.push(input);
    return { id: "notif-id" };
  });
  return { createdNotifications, createNotificationMock };
});

vi.mock("./notifications.service.js", () => ({
  createNotification: createNotificationMock,
}));

import {
  CrmGrantExpiredError,
  isCrmGrantExpiredError,
  markConnectionNeedsReauth,
} from "./crm-auth-lifecycle.service.js";

describe("isCrmGrantExpiredError", () => {
  it("detects CrmGrantExpiredError instances", () => {
    expect(isCrmGrantExpiredError(new CrmGrantExpiredError("hubspot", "revoked"))).toBe(true);
  });

  it("detects BAD_REFRESH_TOKEN and invalid_grant error messages", () => {
    expect(isCrmGrantExpiredError(new Error("HubSpot token refresh failed: 400 BAD_REFRESH_TOKEN"))).toBe(true);
    expect(isCrmGrantExpiredError(new Error("OAuth error: invalid_grant - Refresh token is invalid or expired"))).toBe(true);
    expect(isCrmGrantExpiredError(new Error("token has been revoked by user"))).toBe(true);
    expect(isCrmGrantExpiredError(new Error("HubSpot API failed: 401 unauthorized"))).toBe(true);
  });

  it("returns false for non-grant-expiry errors", () => {
    expect(isCrmGrantExpiredError(new Error("HubSpot API failed: 429 rate limit"))).toBe(false);
    expect(isCrmGrantExpiredError(new Error("Network timeout"))).toBe(false);
    expect(isCrmGrantExpiredError(new Error("Contact validation error: missing email"))).toBe(false);
  });
});

