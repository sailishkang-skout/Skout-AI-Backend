import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { buildInboxService, InboxService } from "./inbox.service.js";
import {
  createInbox,
  deleteInbox,
  getInboxById,
  listDomains,
  listInboxes,
  listThreads,
  pauseInbox,
  resumeInbox,
  updateInbox,
} from "./inbox.service.js";
import { HttpError } from "../utils/http.js";
import { encryptSecret } from "../utils/integration-crypto.js";
import type { Env } from "../config/env.js";

// Hoist nodemailer mock so inbox.service.ts picks it up at import time
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: vi.fn().mockResolvedValue(true),
    })),
  },
}));

// Keep a reference so individual tests can adjust the mock
import nodemailer from "nodemailer";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function selectChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockResolvedValue(result);
  return c;
}

function countChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockResolvedValue(result);
  return c;
}

function threadDataChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.leftJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockReturnValue(c);
  c.offset = vi.fn().mockResolvedValue(result);
  return c;
}

function selectChainWithLimit(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

function updateChain(result: unknown[] = []) {
  const returning = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  return { set, where, returning };
}

function insertChain(result: unknown[]) {
  const returning = vi.fn().mockResolvedValue(result);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, returning });
  return { values, onConflictDoUpdate, returning };
}

function deleteChain(result: unknown[]) {
  const returning = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ returning });
  return { where, returning };
}

const config = { INTEGRATION_ENCRYPTION_KEY: "test-key-32-bytes-long-for-aes!!" } as unknown as Env;

// ---------------------------------------------------------------------------
// buildInboxService factory
// ---------------------------------------------------------------------------

describe("buildInboxService", () => {
  it("returns null when db is unavailable", () => {
    expect(buildInboxService(null, config)).toBeNull();
  });

  it("returns an InboxService instance when db is available", () => {
    expect(buildInboxService({} as any, config)).toBeInstanceOf(InboxService);
  });
});

// ---------------------------------------------------------------------------
// InboxService (class-based)
// ---------------------------------------------------------------------------

describe("InboxService", () => {
  describe("listInboxes", () => {
    it("strips smtpPasswordEncrypted and adds smtpConfigured: true", async () => {
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
    it("throws 503 when INTEGRATION_ENCRYPTION_KEY is not configured but smtpPassword provided", async () => {
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

    it("encrypts the SMTP password and strips it from the returned shape", async () => {
      const insertedRow = {
        id: "inbox-1",
        workspaceId: "ws-1",
        emailAddress: "a@b.com",
        smtpPasswordEncrypted: "iv:tag:cipher",
      };
      const chain = insertChain([insertedRow]);
      const db = { insert: vi.fn().mockReturnValue(chain) } as any;
      const svc = new InboxService(db, config);

      const result = await svc.createInbox("ws-1", {
        emailAddress: "a@b.com",
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpUsername: "user",
        smtpPassword: "super-secret",
      });

      const insertedValues = chain.values.mock.calls[0]![0];
      expect(insertedValues.smtpPasswordEncrypted).not.toContain("super-secret");
      expect(insertedValues.provider).toBe("smtp");
      expect(insertedValues.dailySendLimit).toBe(50);
      expect(result).not.toHaveProperty("smtpPasswordEncrypted");
      expect((result as any).smtpConfigured).toBe(true);
    });

    it("creates inbox without SMTP credentials when no smtpPassword provided", async () => {
      const insertedRow = { id: "inbox-1", emailAddress: "a@b.com", smtpPasswordEncrypted: null };
      const chain = insertChain([insertedRow]);
      const db = { insert: vi.fn().mockReturnValue(chain) } as any;
      const svc = new InboxService(db, config);

      const result = await svc.createInbox("ws-1", { emailAddress: "a@b.com" });

      const insertedValues = chain.values.mock.calls[0]![0];
      expect(insertedValues.smtpPasswordEncrypted).toBeNull();
      expect((result as any).smtpConfigured).toBe(false);
    });

    it("sets smtpSecure: false when port is 587 (STARTTLS) and smtpSecure is not provided", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: "inbox-1", emailAddress: "a@b.com", smtpPasswordEncrypted: null }]);
      const onConflict = vi.fn().mockReturnValue({ returning });
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflict });
      const db = { insert: vi.fn().mockReturnValue({ values }) } as any;
      const svc = new InboxService(db, config);

      await svc.createInbox("ws-1", { emailAddress: "a@b.com", smtpPort: 587 });

      expect(values).toHaveBeenCalledWith(expect.objectContaining({ smtpSecure: false }));
    });

    it("sets smtpSecure: true when port is 465 (SMTPS) and smtpSecure is not provided", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: "inbox-1", emailAddress: "a@b.com", smtpPasswordEncrypted: null }]);
      const onConflict = vi.fn().mockReturnValue({ returning });
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflict });
      const db = { insert: vi.fn().mockReturnValue({ values }) } as any;
      const svc = new InboxService(db, config);

      await svc.createInbox("ws-1", { emailAddress: "a@b.com", smtpPort: 465 });

      expect(values).toHaveBeenCalledWith(expect.objectContaining({ smtpSecure: true }));
    });

    it("respects an explicit smtpSecure: true even on STARTTLS port 587", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: "inbox-1", emailAddress: "a@b.com", smtpPasswordEncrypted: null }]);
      const onConflict = vi.fn().mockReturnValue({ returning });
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflict });
      const db = { insert: vi.fn().mockReturnValue({ values }) } as any;
      const svc = new InboxService(db, config);

      await svc.createInbox("ws-1", { emailAddress: "a@b.com", smtpPort: 587, smtpSecure: true });

      expect(values).toHaveBeenCalledWith(expect.objectContaining({ smtpSecure: true }));
    });
  });

  describe("listThreads", () => {
    it("returns threads for the workspace with pagination metadata", async () => {
      const thread = { id: "thread-1", workspaceId: "ws-1" };
      const countC = countChain([{ total: 1 }]);
      const dataC = {} as Record<string, ReturnType<typeof vi.fn>>;
      dataC.from = vi.fn().mockReturnValue(dataC);
      dataC.where = vi.fn().mockReturnValue(dataC);
      dataC.orderBy = vi.fn().mockReturnValue(dataC);
      dataC.limit = vi.fn().mockReturnValue(dataC);
      dataC.offset = vi.fn().mockResolvedValue([thread]);

      const db = {
        select: vi.fn()
          .mockReturnValueOnce(countC)
          .mockReturnValueOnce(dataC),
      } as any;
      const svc = new InboxService(db, config);

      const result = await svc.listThreads("ws-1");
      expect(result.workspaceId).toBe("ws-1");
      expect(result.total).toBe(1);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.id).toBe("thread-1");
    });
  });
});

// ---------------------------------------------------------------------------
// Function-based service exports
// ---------------------------------------------------------------------------

describe("listInboxes (function)", () => {
  it("returns inboxes with sentToday stats", async () => {
    const inboxRow = { id: "inbox-1", workspaceId: "ws-1" };

    // withDailyStats calls: select().from().innerJoin().where() — where() is terminal
    const statsChain = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn() } as any;
    statsChain.from.mockReturnValue(statsChain);
    statsChain.innerJoin.mockReturnValue(statsChain);
    statsChain.where.mockResolvedValue([{ sentToday: 3 }]);

    const select = vi.fn()
      .mockReturnValueOnce(selectChain([inboxRow])) // inbox list query (terminal: orderBy)
      .mockReturnValueOnce(statsChain);             // daily stats query (terminal: where)

    const db = { select } as any;
    const result = await listInboxes(db, "ws-1");

    expect(result.total).toBe(1);
    expect((result.data[0] as any).sentToday).toBe(3);
  });

  it("returns empty list when no inboxes exist", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) } as any;
    const result = await listInboxes(db, "ws-1");
    expect(result).toEqual({ workspaceId: "ws-1", data: [], total: 0 });
  });
});

describe("getInboxById (function)", () => {
  it("returns null when inbox not found", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChainWithLimit([])) } as any;
    const result = await getInboxById(db, "ws-1", "inbox-missing");
    expect(result).toBeNull();
  });
});

describe("createInbox (function)", () => {
  it("inserts and returns the new inbox row", async () => {
    const row = { id: "inbox-1", emailAddress: "a@b.com", workspaceId: "ws-1" };
    const chain = insertChain([row]);
    const db = { insert: vi.fn().mockReturnValue(chain) } as any;

    const result = await createInbox(db, "ws-1", { emailAddress: "a@b.com" });

    expect(result).toEqual(row);
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: "a@b.com", workspaceId: "ws-1", provider: "smtp" })
    );
  });

  it("defaults dailySendLimit to 50", async () => {
    const chain = insertChain([{ id: "inbox-1" }]);
    const db = { insert: vi.fn().mockReturnValue(chain) } as any;

    await createInbox(db, "ws-1", { emailAddress: "a@b.com" });

    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ dailySendLimit: 50 })
    );
  });
});

describe("updateInbox (function)", () => {
  it("returns updated inbox when found", async () => {
    const row = { id: "inbox-1", displayName: "New Name" };
    const chain = updateChain([row]);
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    const result = await updateInbox(db, "ws-1", "inbox-1", { displayName: "New Name" });
    expect(result).toEqual(row);
  });

  it("returns null when inbox not found", async () => {
    const chain = updateChain([]);
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    const result = await updateInbox(db, "ws-1", "inbox-missing", { displayName: "X" });
    expect(result).toBeNull();
  });
});

describe("pauseInbox (function)", () => {
  it("sets status to paused and returns the row", async () => {
    const row = { id: "inbox-1", status: "paused" };
    const chain = updateChain([row]);
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    const result = await pauseInbox(db, "ws-1", "inbox-1");
    expect(result).toEqual(row);
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }));
  });

  it("returns null when inbox not found", async () => {
    const chain = updateChain([]);
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    expect(await pauseInbox(db, "ws-1", "missing")).toBeNull();
  });
});

describe("resumeInbox (function)", () => {
  it("sets status to active", async () => {
    const chain = updateChain([{ id: "inbox-1" }]);
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    await resumeInbox(db, "ws-1", "inbox-1");
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("resets health counters when resetCounters is true", async () => {
    const chain = updateChain([{ id: "inbox-1" }]);
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    await resumeInbox(db, "ws-1", "inbox-1", true);
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ bounceCount: 0, spamCount: 0, sentCount: 0 })
    );
  });

  it("does not reset counters when resetCounters is false", async () => {
    const chain = updateChain([{ id: "inbox-1" }]);
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    await resumeInbox(db, "ws-1", "inbox-1", false);
    const calledWith = chain.set.mock.calls[0]![0];
    expect(calledWith).not.toHaveProperty("bounceCount");
    expect(calledWith).not.toHaveProperty("spamCount");
  });
});

describe("deleteInbox (function)", () => {
  it("returns true when inbox is deleted", async () => {
    const chain = deleteChain([{ id: "inbox-1" }]);
    const db = { delete: vi.fn().mockReturnValue(chain) } as any;

    expect(await deleteInbox(db, "ws-1", "inbox-1")).toBe(true);
  });

  it("returns false when inbox not found", async () => {
    const chain = deleteChain([]);
    const db = { delete: vi.fn().mockReturnValue(chain) } as any;

    expect(await deleteInbox(db, "ws-1", "missing")).toBe(false);
  });
});

describe("listDomains (function)", () => {
  it("returns shaped domain objects for the workspace", async () => {
    const rows = [
      {
        id: "domain-1",
        workspaceId: "ws-1",
        domain: "skout.ai",
        dnsRecords: [
          { purpose: "SPF", status: "pass", type: "TXT", name: "skout.ai", value: "v=spf1" },
          { purpose: "DKIM", status: "unknown", type: "TXT", name: "_dkey.skout.ai", value: "v=DKIM1" },
        ],
        verifiedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        status: "pending_verification",
      },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(rows)) } as any;

    const result = await listDomains(db, "ws-1");
    expect(result).toEqual({
      workspaceId: "ws-1",
      data: [
        {
          id: "domain-1",
          workspaceId: "ws-1",
          domain: "skout.ai",
          spfStatus: "pass",
          dkimStatus: "unknown",
          dmarcStatus: "unknown",
          mxStatus: "unknown",
          verifiedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
    });
  });
});

describe("listThreads (function)", () => {
  it("returns inbox threads for the workspace", async () => {
    const rows = [{ id: "thread-1", workspaceId: "ws-1" }];
    const db = { select: vi.fn().mockReturnValue(selectChain(rows)) } as any;

    const result = await listThreads(db, "ws-1");
    expect(result).toEqual({ workspaceId: "ws-1", data: rows, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// toPublicInbox — oauthConfigured field (via InboxService.listInboxes)
// ---------------------------------------------------------------------------

describe("InboxService — toPublicInbox oauthConfigured", () => {
  it("adds oauthConfigured: true when oauthAccessTokenEncrypted is set", async () => {
    const row = {
      id: "inbox-1",
      workspaceId: "ws-1",
      emailAddress: "a@b.com",
      smtpPasswordEncrypted: null,
      oauthAccessTokenEncrypted: "iv:tag:cipher",
      oauthRefreshTokenEncrypted: "iv:tag:cipher2",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const db = { select: vi.fn().mockReturnValue(selectChain([row])) } as any;
    const svc = new InboxService(db, config);

    const result = await svc.listInboxes("ws-1");
    expect((result.data[0] as any).oauthConfigured).toBe(true);
  });

  it("adds oauthConfigured: false when oauthAccessTokenEncrypted is null", async () => {
    const row = {
      id: "inbox-1",
      workspaceId: "ws-1",
      smtpPasswordEncrypted: "iv:tag:cipher",
      oauthAccessTokenEncrypted: null,
    };
    const db = { select: vi.fn().mockReturnValue(selectChain([row])) } as any;
    const svc = new InboxService(db, config);

    const result = await svc.listInboxes("ws-1");
    expect((result.data[0] as any).oauthConfigured).toBe(false);
  });

  it("strips oauthAccessTokenEncrypted and oauthRefreshTokenEncrypted from response", async () => {
    const row = {
      id: "inbox-1",
      workspaceId: "ws-1",
      oauthAccessTokenEncrypted: "iv:tag:access",
      oauthRefreshTokenEncrypted: "iv:tag:refresh",
    };
    const db = { select: vi.fn().mockReturnValue(selectChain([row])) } as any;
    const svc = new InboxService(db, config);

    const result = await svc.listInboxes("ws-1");
    expect(result.data[0]).not.toHaveProperty("oauthAccessTokenEncrypted");
    expect(result.data[0]).not.toHaveProperty("oauthRefreshTokenEncrypted");
  });
});

// ---------------------------------------------------------------------------
// computeHealth — tested indirectly via listInboxes (standalone function)
// ---------------------------------------------------------------------------

describe("listInboxes — computeHealth field", () => {
  function buildDb(inboxRow: Record<string, unknown>) {
    const statsChain = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn() } as any;
    statsChain.from.mockReturnValue(statsChain);
    statsChain.innerJoin.mockReturnValue(statsChain);
    statsChain.where.mockResolvedValue([{ sentToday: 0 }]);

    const select = vi.fn()
      .mockReturnValueOnce(selectChain([inboxRow]))
      .mockReturnValueOnce(statsChain);

    return { select } as any;
  }

  const baseInbox = {
    id: "inbox-1",
    workspaceId: "ws-1",
    dailySendLimit: 50,
    sentCount: 0,
    bounceCount: 0,
    spamCount: 0,
  };

  it("returns health: 'error' for a paused inbox", async () => {
    const db = buildDb({ ...baseInbox, status: "paused", smtpHost: "smtp.test.com", smtpPasswordEncrypted: "enc" });
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).health).toBe("error");
  });

  it("returns health: 'error' when no SMTP and no OAuth config", async () => {
    const db = buildDb({ ...baseInbox, status: "active", smtpHost: null, smtpPasswordEncrypted: null, oauthAccessTokenEncrypted: null });
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).health).toBe("error");
  });

  it("returns health: 'healthy' for a configured active inbox with low bounce/spam", async () => {
    const db = buildDb({
      ...baseInbox,
      status: "active",
      smtpHost: "smtp.test.com",
      smtpPasswordEncrypted: "enc",
      sentCount: 100,
      bounceCount: 2,
      spamCount: 0,
    });
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).health).toBe("healthy");
  });

  it("returns health: 'degraded' when bounce rate >= 5%", async () => {
    const db = buildDb({
      ...baseInbox,
      status: "active",
      smtpHost: "smtp.test.com",
      smtpPasswordEncrypted: "enc",
      sentCount: 100,
      bounceCount: 6, // 6% bounce rate
      spamCount: 0,
    });
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).health).toBe("degraded");
  });

  it("returns health: 'degraded' when spam rate >= 1%", async () => {
    const db = buildDb({
      ...baseInbox,
      status: "active",
      smtpHost: "smtp.test.com",
      smtpPasswordEncrypted: "enc",
      sentCount: 100,
      bounceCount: 0,
      spamCount: 2, // 2% spam rate
    });
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).health).toBe("degraded");
  });

  it("does not flag degraded before minSent threshold (20)", async () => {
    const db = buildDb({
      ...baseInbox,
      status: "active",
      smtpHost: "smtp.test.com",
      smtpPasswordEncrypted: "enc",
      sentCount: 10,
      bounceCount: 5, // 50% bounce but only 10 sent — below minSent
      spamCount: 0,
    });
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).health).toBe("healthy");
  });

  it("returns health: 'healthy' for OAuth-only configured inbox", async () => {
    const db = buildDb({
      ...baseInbox,
      status: "active",
      smtpHost: null,
      smtpPasswordEncrypted: null,
      oauthAccessTokenEncrypted: "iv:tag:enc",
    });
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).health).toBe("healthy");
  });

  it("includes capPct based on sentToday / dailySendLimit", async () => {
    const statsChain = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn() } as any;
    statsChain.from.mockReturnValue(statsChain);
    statsChain.innerJoin.mockReturnValue(statsChain);
    statsChain.where.mockResolvedValue([{ sentToday: 25 }]);

    const select = vi.fn()
      .mockReturnValueOnce(selectChain([{ ...baseInbox, status: "active", smtpPasswordEncrypted: "enc", smtpHost: "h", dailySendLimit: 50 }]))
      .mockReturnValueOnce(statsChain);

    const db = { select } as any;
    const result = await listInboxes(db, "ws-1");
    expect((result.data[0] as any).capPct).toBe(50); // 25/50 * 100 = 50
  });
});

// ---------------------------------------------------------------------------
// InboxService.testSend
// ---------------------------------------------------------------------------

describe("InboxService.testSend", () => {
  const ENC_KEY = "test-key-32-bytes-long-for-aes!!";
  const testConfig = { INTEGRATION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env;

  function withInboxSelect(inbox: unknown) {
    const c = {} as Record<string, ReturnType<typeof vi.fn>>;
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockResolvedValue(inbox ? [inbox] : []);
    return c;
  }

  function withUpdateChain() {
    const c = {} as Record<string, ReturnType<typeof vi.fn>>;
    c.set = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockResolvedValue([]);
    return c;
  }

  it("throws 404 when inbox not found", async () => {
    const db = { select: vi.fn().mockReturnValue(withInboxSelect(null)) } as any;
    const svc = new InboxService(db, testConfig);
    await expect(svc.testSend("ws-1", "missing")).rejects.toThrow(HttpError);
  });

  it("throws 503 when INTEGRATION_ENCRYPTION_KEY is not configured", async () => {
    const inbox = { id: "inbox-1", workspaceId: "ws-1", provider: "smtp", smtpPasswordEncrypted: "enc" };
    const db = { select: vi.fn().mockReturnValue(withInboxSelect(inbox)) } as any;
    const svc = new InboxService(db, {} as unknown as Env);
    await expect(svc.testSend("ws-1", "inbox-1")).rejects.toThrow(HttpError);
  });

  it("throws 422 when SMTP inbox has no credentials", async () => {
    const inbox = {
      id: "inbox-1",
      workspaceId: "ws-1",
      provider: "smtp",
      smtpHost: null,
      smtpPort: null,
      smtpUsername: null,
      smtpPasswordEncrypted: null,
      oauthAccessTokenEncrypted: null,
    };
    const db = { select: vi.fn().mockReturnValue(withInboxSelect(inbox)) } as any;
    const svc = new InboxService(db, testConfig);
    await expect(svc.testSend("ws-1", "inbox-1")).rejects.toThrow(HttpError);
  });

  it("uses SMTP path and activates inbox on successful verify", async () => {
    const encPass = encryptSecret("smtp-password", ENC_KEY);
    const inbox = {
      id: "inbox-1",
      workspaceId: "ws-1",
      provider: "smtp",
      emailAddress: "sender@example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUsername: "sender@example.com",
      smtpPasswordEncrypted: encPass,
      smtpSecure: false,
      oauthAccessTokenEncrypted: null,
    };

    const upd = withUpdateChain();
    const db = {
      select: vi.fn().mockReturnValue(withInboxSelect(inbox)),
      update: vi.fn().mockReturnValue(upd),
    } as any;

    const svc = new InboxService(db, testConfig);
    const result = await svc.testSend("ws-1", "inbox-1");

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("smtp");
    expect(upd.set).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("falls back to SMTP path for google/microsoft inbox without OAuth tokens", async () => {
    const encPass = encryptSecret("app-password", ENC_KEY);
    const inbox = {
      id: "inbox-1",
      workspaceId: "ws-1",
      provider: "google",
      emailAddress: "user@gmail.com",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpUsername: "user@gmail.com",
      smtpPasswordEncrypted: encPass,
      smtpSecure: true,
      oauthAccessTokenEncrypted: null, // no OAuth tokens → fall back to SMTP
    };

    const upd = withUpdateChain();
    const db = {
      select: vi.fn().mockReturnValue(withInboxSelect(inbox)),
      update: vi.fn().mockReturnValue(upd),
    } as any;

    const svc = new InboxService(db, testConfig);
    const result = await svc.testSend("ws-1", "inbox-1");

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("google");
    // Should have activated
    expect(upd.set).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });
});
