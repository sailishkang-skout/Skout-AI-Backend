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

describe("markConnectionNeedsReauth", () => {
  beforeEach(() => {
    createdNotifications.length = 0;
    createNotificationMock.mockClear();
  });

  it("updates crm_connections status to needs_reauth and creates alerts", async () => {
    const existingRow = {
      id: "conn-123",
      status: "connected",
      settings: { original: true },
    };

    let updatedSet: unknown;
    const dbMock = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existingRow]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((val) => {
          updatedSet = val;
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      }),
      selectDistinct: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ userId: "user-admin-1" }, { userId: "user-owner-1" }]),
          }),
        }),
      }),
    };

    await markConnectionNeedsReauth(dbMock as any, {} as any, {
      workspaceId: "ws-100",
      provider: "hubspot",
      reason: "Refresh token is invalid or expired",
    });

    // Verifies status was updated to needs_reauth with error details in settings
    expect(updatedSet).toMatchObject({
      status: "needs_reauth",
      settings: expect.objectContaining({
        original: true,
        lastAuthError: "Refresh token is invalid or expired",
      }),
    });

    // Verifies workspace-wide (userId: null) notification was created
    expect(createdNotifications).toContainEqual(
      expect.objectContaining({
        workspaceId: "ws-100",
        userId: null,
        type: "crm_grant_expired",
        title: "Hubspot Reconnection Required",
        entityType: "crm_connection",
        entityId: "conn-123",
      })
    );

    // Verifies direct notifications to admin and owner were created
    expect(createdNotifications).toContainEqual(
      expect.objectContaining({
        workspaceId: "ws-100",
        userId: "user-admin-1",
        type: "crm_grant_expired",
      })
    );
    expect(createdNotifications).toContainEqual(
      expect.objectContaining({
        workspaceId: "ws-100",
        userId: "user-owner-1",
        type: "crm_grant_expired",
      })
    );
  });
});

