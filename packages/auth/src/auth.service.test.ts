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
