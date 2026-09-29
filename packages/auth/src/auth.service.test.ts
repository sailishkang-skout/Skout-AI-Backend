import { describe, expect, it, vi } from "vitest";
import { resolveOrProvisionUser } from "./auth.service.js";

function selectChain(result: unknown[]) {
  const resolved = Promise.resolve(result);
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  (c as { then?: unknown }).then = resolved.then.bind(resolved);
  return c;
}

function insertReturning(result: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function insertVoid() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function insertReturningDirect(result: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result),
    }),
  };
}

function insertConflictVoid() {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue([]),
    }),
  };
}

describe("resolveOrProvisionUser — unverified email (AUTH-BE-03)", () => {
  it("does not run an email lookup when emailVerified is false", async () => {
    const createdUser = {
      id: "u-new",
      email: "unverified+clerk%3Auser_x@accounts.skout.internal",
      status: "active",
      isBlocked: false,
    };
    const workspace = { id: "ws-new" };

    const tx = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    };

    tx.select
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]));

    tx.insert
      .mockReturnValueOnce(insertReturning([createdUser]))
      .mockReturnValueOnce(insertConflictVoid())
      .mockReturnValueOnce(insertReturningDirect([workspace]))
      .mockReturnValueOnce(insertVoid())
      .mockReturnValueOnce(insertVoid())
      .mockReturnValueOnce(insertVoid());

    const db = {
      transaction: vi.fn((cb: (inner: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    await resolveOrProvisionUser(db as any, {
      provider: "clerk",
      subject: "user_x",
      email: "owner@example.com",
      emailVerified: false,
      name: "New",
    });

    expect(tx.select).toHaveBeenCalledTimes(4);
  });
});

describe("resolveOrProvisionUser — Skout own-auth provider (AUTH-BE-19)", () => {
  const validUserId = "11111111-1111-4111-8111-111111111111";
  const validSessionId = "22222222-2222-4222-8222-222222222222";
  const validWsId = "33333333-3333-4333-8333-333333333333";

  it("throws 401 when user does not exist for Skout token (never auto-provisions)", async () => {
    const tx = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    tx.select.mockReturnValueOnce(selectChain([])); // findExistingUser returns none

    const db = {
      transaction: vi.fn((cb: (inner: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    await expect(
      resolveOrProvisionUser(db as any, {
        provider: "skout",
        subject: validUserId,
        sessionId: validSessionId,
        emailVerified: true,
      })
    ).rejects.toThrow("User not found");
  });

  it("throws 403 when user is inactive or blocked", async () => {
    const tx = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    tx.select.mockReturnValueOnce(
      selectChain([
        {
          id: validUserId,
          email: "blocked@example.com",
          status: "active",
          isBlocked: true,
        },
      ])
    );

    const db = {
      transaction: vi.fn((cb: (inner: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    await expect(
      resolveOrProvisionUser(db as any, {
        provider: "skout",
        subject: validUserId,
        sessionId: validSessionId,
        emailVerified: true,
      })
    ).rejects.toThrow("Account is inactive or blocked");
  });

  it("throws 401 AUTH_SESSION_REVOKED when session is revoked", async () => {
    const tx = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    tx.select
      .mockReturnValueOnce(
        selectChain([
          {
            id: validUserId,
            email: "user@example.com",
            status: "active",
            isBlocked: false,
          },
        ])
      )
      .mockReturnValueOnce(
        selectChain([
          {
            id: validSessionId,
            revokedAt: new Date(),
            absoluteExpiresAt: new Date(Date.now() + 100000),
            idleExpiresAt: new Date(Date.now() + 100000),
          },
        ])
      );

    const db = {
      transaction: vi.fn((cb: (inner: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    await expect(
      resolveOrProvisionUser(db as any, {
        provider: "skout",
        subject: validUserId,
        sessionId: validSessionId,
        emailVerified: true,
      })
    ).rejects.toThrow("AUTH_SESSION_REVOKED");
  });

  it("successfully resolves existing user with active session and workspace", async () => {
    const tx = {
      select: vi.fn(),
      insert: vi.fn().mockReturnValue(insertConflictVoid()),
      update: vi.fn(),
    };
    tx.select
      .mockReturnValueOnce(
        selectChain([
          {
            id: validUserId,
            email: "user@example.com",
            status: "active",
            isBlocked: false,
          },
        ])
      )
      .mockReturnValueOnce(
        selectChain([
          {
            id: validSessionId,
            revokedAt: null,
            absoluteExpiresAt: new Date(Date.now() + 100000),
            idleExpiresAt: new Date(Date.now() + 100000),
          },
        ])
      )
      .mockReturnValueOnce(
        selectChain([
          {
            workspaceId: validWsId,
            role: "owner",
          },
        ])
      )
      .mockReturnValueOnce(
        selectChain([
          {
            workspaceId: validWsId,
          },
        ])
      )
      .mockReturnValueOnce(selectChain([]));

    const db = {
      transaction: vi.fn((cb: (inner: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    const result = await resolveOrProvisionUser(db as any, {
      provider: "skout",
      subject: validUserId,
      sessionId: validSessionId,
      email: "user@example.com",
      emailVerified: true,
    });

    expect(result).toEqual({
      userId: validUserId,
      userEmail: "user@example.com",
      workspaceId: validWsId,
      role: "owner",
    });
  });
});

