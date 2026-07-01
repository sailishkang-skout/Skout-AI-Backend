import { describe, expect, it, vi } from "vitest";
import { buildInboxService, InboxService } from "./inbox.service.js";
import { HttpError } from "../utils/http.js";
import type { Env } from "../config/env.js";

function selectChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockResolvedValue(result);
  return c;
}

const config = { INTEGRATION_ENCRYPTION_KEY: "test-key" } as unknown as Env;

describe("buildInboxService", () => {
  it("returns null when db is unavailable", () => {
    expect(buildInboxService(null, config)).toBeNull();
  });

  it("returns an InboxService instance when db is available", () => {
    expect(buildInboxService({} as any, config)).toBeInstanceOf(InboxService);
  });
});

describe("InboxService", () => {
  describe("listInboxes", () => {
    it("strips smtpPasswordEncrypted and adds smtpConfigured", async () => {
      const row = {
        id: "inbox-1",
        workspaceId: "ws-1",
        emailAddress: "a@b.com",
        smtpPasswordEncrypted: "iv:tag:cipher",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      };
      const db = { select: vi.fn().mockReturnValue(selectChain([row])) } as any;
      const svc = new InboxService(db, config);

      const result = await svc.listInboxes("ws-1");
      expect(result.total).toBe(1);
      expect(result.data[0]).not.toHaveProperty("smtpPasswordEncrypted");
      expect((result.data[0] as any).smtpConfigured).toBe(true);
    });

    it("returns smtpConfigured: false when no password is stored", async () => {
      const row = { id: "inbox-1", smtpPasswordEncrypted: null };
      const db = { select: vi.fn().mockReturnValue(selectChain([row])) } as any;
      const svc = new InboxService(db, config);

      const result = await svc.listInboxes("ws-1");
      expect((result.data[0] as any).smtpConfigured).toBe(false);
    });
  });

  describe("createInbox", () => {
    it("throws 503 when INTEGRATION_ENCRYPTION_KEY is not configured", async () => {
      const db = {} as any;
      const svc = new InboxService(db, { INTEGRATION_ENCRYPTION_KEY: undefined } as unknown as Env);

      await expect(
        svc.createInbox("ws-1", {
          emailAddress: "a@b.com",
          smtpHost: "smtp.example.com",
          smtpPort: 587,
          smtpUsername: "user",
          smtpPassword: "pass",
        })
      ).rejects.toThrow(HttpError);
    });

    it("encrypts the SMTP password before inserting and returns the public shape", async () => {
      const insertedRow = {
        id: "inbox-1",
        workspaceId: "ws-1",
        emailAddress: "a@b.com",
        smtpPasswordEncrypted: "iv:tag:cipher",
      };
      const returning = vi.fn().mockResolvedValue([insertedRow]);
      const values = vi.fn().mockReturnValue({ returning });
      const db = { insert: vi.fn().mockReturnValue({ values }) } as any;
      const svc = new InboxService(db, config);

      const result = await svc.createInbox("ws-1", {
        emailAddress: "a@b.com",
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpUsername: "user",
        smtpPassword: "super-secret",
      });

      const insertedValues = values.mock.calls[0]![0];
      expect(insertedValues.smtpPasswordEncrypted).not.toContain("super-secret");
      expect(insertedValues.provider).toBe("smtp");
      expect(insertedValues.dailySendLimit).toBe(50);
      expect(result).not.toHaveProperty("smtpPasswordEncrypted");
      expect((result as any).smtpConfigured).toBe(true);
    });
  });

  describe("listThreads", () => {
    it("returns threads for the workspace", async () => {
      const rows = [{ id: "thread-1", workspaceId: "ws-1" }];
      const db = { select: vi.fn().mockReturnValue(selectChain(rows)) } as any;
      const svc = new InboxService(db, config);

      const result = await svc.listThreads("ws-1");
      expect(result).toEqual({ workspaceId: "ws-1", data: rows, total: 1 });
    });
  });
});
