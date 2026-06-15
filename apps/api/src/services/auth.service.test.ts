import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveOrProvisionUser } from "./auth.service.js";
import { HttpError } from "../utils/http.js";

// Build a chainable select mock that resolves with `result` at .limit()
function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

// Build a chainable insert mock:
//   mode "returning" → .values().returning() resolves with result
//   mode "returning+conflict" → .values().onConflictDoUpdate().returning() resolves with result
//   mode "void" → .values() resolves with []
function insertChain(mode: "void" | "returning" | "returning+conflict", result: unknown[] = []) {
  if (mode === "void") {
    return { values: vi.fn().mockResolvedValue([]) };
  }
  if (mode === "returning") {
    return {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    };
  }
  // returning+conflict
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

// Build a chainable update mock → .set().where() resolves
function updateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  };
}

function makeTx(overrides: {
  selects?: unknown[][];
  inserts?: Array<{ mode: "void" | "returning" | "returning+conflict"; result?: unknown[] }>;
  withUpdate?: boolean;
}) {
  const tx = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  for (const result of overrides.selects ?? []) {
    tx.select.mockReturnValueOnce(selectChain(result));
  }
  for (const { mode, result } of overrides.inserts ?? []) {
    tx.insert.mockReturnValueOnce(insertChain(mode, result));
  }
  if (overrides.withUpdate) {
    tx.update.mockReturnValueOnce(updateChain());
  }

  return tx;
}

function makeDb(tx: ReturnType<typeof makeTx>) {
  return {
    transaction: vi.fn((cb: (innerTx: ReturnType<typeof makeTx>) => Promise<unknown>) => cb(tx)),
  };
}

const BASE_USER = { id: "u-1", email: "test@example.com", status: "active", isBlocked: false };
const BASE_MEMBERSHIP = { workspaceId: "ws-1", role: "owner" };
const NEW_USER = { id: "u-new", email: "new@example.com", status: "active", isBlocked: false };
const NEW_WORKSPACE = { id: "ws-new" };

describe("resolveOrProvisionUser", () => {
  describe("returning user — found by clerkUserId", () => {
    it("returns userId, workspaceId, role without any inserts", async () => {
      const tx = makeTx({
        selects: [
          [BASE_USER],       // user by clerkUserId
          [BASE_MEMBERSHIP], // membership
        ],
      });
      const db = makeDb(tx);

      const result = await resolveOrProvisionUser(db as any, "clerk_1", "test@example.com", "Test User");

      expect(result).toEqual({
        userId: "u-1",
        userEmail: "test@example.com",
        workspaceId: "ws-1",
        role: "owner",
      });
      expect(tx.insert).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  describe("returning user — found by email (back-fill clerkUserId)", () => {
    it("updates clerkUserId and returns workspace membership", async () => {
      const tx = makeTx({
        selects: [
          [],                // user by clerkUserId → miss
          [BASE_USER],       // user by email → hit
          [BASE_MEMBERSHIP], // membership
        ],
        withUpdate: true,
      });
      const db = makeDb(tx);

      const result = await resolveOrProvisionUser(db as any, "clerk_new", "test@example.com", "Test User");

      expect(result.userId).toBe("u-1");
      expect(result.workspaceId).toBe("ws-1");
      expect(tx.update).toHaveBeenCalledTimes(1);
      expect(tx.insert).not.toHaveBeenCalled();
    });
  });

  describe("new user — full workspace provision", () => {
    it("creates user, workspace, member, credit balance, and credit transaction", async () => {
      const tx = makeTx({
        selects: [
          [],  // clerkUserId miss
          [],  // email miss
          [],  // membership miss
        ],
        inserts: [
          { mode: "returning+conflict", result: [NEW_USER] },    // insert user
          { mode: "returning",          result: [NEW_WORKSPACE] }, // insert workspace
          { mode: "void" },                                       // insert workspace_member
          { mode: "void" },                                       // insert credit_balance
          { mode: "void" },                                       // insert credit_transaction
        ],
      });
      const db = makeDb(tx);

      const result = await resolveOrProvisionUser(db as any, "clerk_x", "new@example.com", "New User");

      expect(result).toEqual({
        userId: "u-new",
        userEmail: "new@example.com",
        workspaceId: "ws-new",
        role: "owner",
      });
      expect(tx.insert).toHaveBeenCalledTimes(5);
      expect(tx.update).not.toHaveBeenCalled();
    });

    it("grants 500 credits in the credit_transactions insert", async () => {
      const tx = makeTx({
        selects: [[], [], []],
        inserts: [
          { mode: "returning+conflict", result: [NEW_USER] },
          { mode: "returning",          result: [NEW_WORKSPACE] },
          { mode: "void" },
          { mode: "void" },
          { mode: "void" },
        ],
      });
      const db = makeDb(tx);
      await resolveOrProvisionUser(db as any, "clerk_x", "new@example.com", "New User");

      // 5th insert call is credit_transactions — check .values() arg
      const ctInsertCall = (tx.insert.mock.results[4].value as ReturnType<typeof insertChain>);
      const valuesFn = (ctInsertCall as { values: ReturnType<typeof vi.fn> }).values;
      expect(valuesFn).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 500, action: "provision" })
      );
    });
  });

  describe("existing user with no workspace yet (edge case)", () => {
    it("provisions workspace for a user that exists but has no membership", async () => {
      const tx = makeTx({
        selects: [
          [BASE_USER], // clerkUserId hit
          [],          // membership miss
        ],
        inserts: [
          { mode: "returning", result: [NEW_WORKSPACE] },
          { mode: "void" },
          { mode: "void" },
          { mode: "void" },
        ],
      });
      const db = makeDb(tx);

      const result = await resolveOrProvisionUser(db as any, "clerk_1", "test@example.com", "Test User");

      expect(result.workspaceId).toBe("ws-new");
      expect(result.role).toBe("owner");
      expect(tx.insert).toHaveBeenCalledTimes(4);
    });
  });

  describe("access control", () => {
    it("throws HttpError 403 when user status is not active", async () => {
      const tx = makeTx({ selects: [[{ ...BASE_USER, status: "suspended" }]] });
      const db = makeDb(tx);
      await expect(
        resolveOrProvisionUser(db as any, "clerk_1", "test@example.com", "Test")
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("includes statusCode 403 in the error when user is suspended", async () => {
      const tx = makeTx({ selects: [[{ ...BASE_USER, status: "suspended" }]] });
      const db = makeDb(tx);
      await expect(
        resolveOrProvisionUser(db as any, "clerk_1", "test@example.com", "Test")
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("throws HttpError 403 when user is blocked", async () => {
      const tx = makeTx({
        selects: [[{ ...BASE_USER, isBlocked: true }]],
      });
      const db = makeDb(tx);

      await expect(
        resolveOrProvisionUser(db as any, "clerk_1", "test@example.com", "Test")
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe("error propagation", () => {
    it("throws when workspace insert returns empty (DB constraint violation)", async () => {
      const tx = makeTx({
        selects: [[], [], []],
        inserts: [
          { mode: "returning+conflict", result: [NEW_USER] },
          { mode: "returning", result: [] }, // workspace insert returns nothing
        ],
      });
      const db = makeDb(tx);

      await expect(
        resolveOrProvisionUser(db as any, "clerk_x", "new@example.com", "New User")
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("throws when user insert returns empty", async () => {
      const tx = makeTx({
        selects: [[], []],
        inserts: [
          { mode: "returning+conflict", result: [] }, // user insert returns nothing
        ],
      });
      const db = makeDb(tx);

      await expect(
        resolveOrProvisionUser(db as any, "clerk_x", "new@example.com", "New User")
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});
