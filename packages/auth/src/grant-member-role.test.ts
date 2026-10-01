import { describe, expect, it, vi } from "vitest";
import { grantSystemMemberRole } from "./grant-member-role.js";

function fakeDb(roleRows: unknown[]) {
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const limit = vi.fn().mockResolvedValue(roleRows);
  const db = {
    select: vi.fn().mockReturnValue({ from: () => ({ where: () => ({ limit }) }) }),
    insert: vi.fn().mockReturnValue({ values }),
  };
  return { db, values, onConflictDoNothing };
}

describe("grantSystemMemberRole", () => {
  it("inserts a workspace_member_roles grant for the seeded system role", async () => {
    const { db, values, onConflictDoNothing } = fakeDb([{ id: "role-owner" }]);
    const ok = await grantSystemMemberRole(db as never, "ws-1", "u-1", "owner");
    expect(ok).toBe(true);
    expect(values).toHaveBeenCalledWith({ workspaceId: "ws-1", userId: "u-1", roleId: "role-owner" });
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it("returns false without inserting when the system role is not seeded", async () => {
    const { db } = fakeDb([]);
    const ok = await grantSystemMemberRole(db as never, "ws-1", "u-1", "owner");
    expect(ok).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
