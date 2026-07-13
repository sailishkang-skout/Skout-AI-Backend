import { describe, expect, it, vi } from "vitest";
import { createTeamService } from "./team.service.js";
import { HttpError } from "../utils/http.js";

// ── Mock DB chain builders ────────────────────────────────────────────────

function selectChain(result: unknown[]) {
  const limitFn = vi.fn().mockResolvedValue(result);
  const whereResult = Object.assign(Promise.resolve(result), {
    limit: limitFn,
  });
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.leftJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(whereResult);
  chain.limit = limitFn;
  return chain;
}

function updateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function insertChain() {
  return { values: vi.fn().mockResolvedValue(undefined) };
}

function deleteChain() {
  return { where: vi.fn().mockResolvedValue(undefined) };
}

function makeMockDb(opts: {
  selects?: unknown[][];
  withUpdate?: boolean;
  withInsert?: boolean;
  withDelete?: boolean;
} = {}) {
  const db = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  for (const r of opts.selects ?? []) {
    db.select.mockReturnValueOnce(selectChain(r));
  }
  if (opts.withUpdate) db.update.mockReturnValue(updateChain());
  if (opts.withInsert) db.insert.mockReturnValue(insertChain());
  if (opts.withDelete) db.delete.mockReturnValue(deleteChain());
  return db;
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1000);

const MEMBER_ROW = {
  userId: "user-1",
  role: "member",
  joinedAt: new Date("2026-01-01"),
  email: "member@acme.com",
  fullName: "Test Member",
};

const INVITE_ROW = {
  id: "inv-1",
  workspaceId: "ws-1",
  invitedByUserId: "user-owner",
  email: "new@acme.com",
  role: "member",
  token: "abc123",
  expiresAt: FUTURE,
  acceptedAt: null,
  createdAt: new Date("2026-01-01"),
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe("createTeamService", () => {
  describe("listMembers", () => {
    it("returns formatted members for a workspace", async () => {
      const db = makeMockDb({ selects: [[MEMBER_ROW]] });
      const svc = createTeamService(db as any);
      const result = await svc.listMembers("ws-1");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        userId: "user-1",
        email: "member@acme.com",
        fullName: "Test Member",
        role: "member",
      });
      expect(typeof result[0]!.joinedAt).toBe("string");
    });

    it("returns empty array when workspace has no members", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      expect(await svc.listMembers("ws-empty")).toEqual([]);
    });
  });

  describe("listPendingInvites", () => {
    it("returns pending non-expired invites", async () => {
      const db = makeMockDb({ selects: [[INVITE_ROW]] });
      const svc = createTeamService(db as any);
      const result = await svc.listPendingInvites("ws-1");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: "inv-1", email: "new@acme.com", role: "member" });
      expect(typeof result[0]!.expiresAt).toBe("string");
    });

    it("returns empty array when no pending invites", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      expect(await svc.listPendingInvites("ws-1")).toEqual([]);
    });
  });

  describe("inviteMember", () => {
    it("throws 403 when requesting role is member", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(
        svc.inviteMember("ws-1", "uid", "x@x.com", "member", "member")
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("throws 403 when admin tries to invite an admin", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(
        svc.inviteMember("ws-1", "uid", "x@x.com", "admin", "admin")
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("throws 409 when email is already a workspace member", async () => {
      const db = makeMockDb({ selects: [[{ userId: "existing" }], []] });
      const svc = createTeamService(db as any);
      await expect(
        svc.inviteMember("ws-1", "uid", "member@acme.com", "member", "owner")
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("creates a new invite when no pending exists for this email", async () => {
      const db = makeMockDb({ selects: [[], []], withInsert: true });
      const svc = createTeamService(db as any);
      const result = await svc.inviteMember("ws-1", "uid", "new@acme.com", "member", "owner");
      expect(result.email).toBe("new@acme.com");
      expect(result.role).toBe("member");
      expect(result.token).toHaveLength(64);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("refreshes the token when a pending invite already exists", async () => {
      const db = makeMockDb({ selects: [[], [{ id: "existing-inv" }]], withUpdate: true });
      const svc = createTeamService(db as any);
      const result = await svc.inviteMember("ws-1", "uid", "new@acme.com", "member", "admin");
      expect(result.token).toHaveLength(64);
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("normalises email to lowercase", async () => {
      const db = makeMockDb({ selects: [[], []], withInsert: true });
      const svc = createTeamService(db as any);
      const result = await svc.inviteMember("ws-1", "uid", "NEW@ACME.COM", "member", "owner");
      expect(result.email).toBe("new@acme.com");
    });

    it("owner can invite an admin", async () => {
      const db = makeMockDb({ selects: [[], []], withInsert: true });
      const svc = createTeamService(db as any);
      const result = await svc.inviteMember("ws-1", "uid", "new@acme.com", "admin", "owner");
      expect(result.role).toBe("admin");
    });
  });

  describe("getInviteByToken", () => {
    it("returns null when token not found", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      expect(await svc.getInviteByToken("no-such-token")).toBeNull();
    });

    it("returns formatted invite with accepted=false expired=false for a valid invite", async () => {
      const row = { ...INVITE_ROW, workspaceName: "Acme Corp" };
      const db = makeMockDb({ selects: [[row]] });
      const svc = createTeamService(db as any);
      const result = await svc.getInviteByToken("abc123");
      expect(result).toMatchObject({
        id: "inv-1",
        email: "new@acme.com",
        role: "member",
        workspaceName: "Acme Corp",
        accepted: false,
        expired: false,
      });
      expect(typeof result!.expiresAt).toBe("string");
    });

    it("returns accepted=true when acceptedAt is set", async () => {
      const row = { ...INVITE_ROW, acceptedAt: new Date(), workspaceName: "Acme" };
      const db = makeMockDb({ selects: [[row]] });
      const svc = createTeamService(db as any);
      expect((await svc.getInviteByToken("abc123"))!.accepted).toBe(true);
    });

    it("returns expired=true when expiresAt is in the past", async () => {
      const row = { ...INVITE_ROW, expiresAt: PAST, workspaceName: "Acme" };
      const db = makeMockDb({ selects: [[row]] });
      const svc = createTeamService(db as any);
      expect((await svc.getInviteByToken("abc123"))!.expired).toBe(true);
    });
  });

  describe("acceptInvite", () => {
    it("throws 404 when invite not found", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      await expect(svc.acceptInvite("bad-token", "uid", "u@u.com"))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 409 when invite already accepted", async () => {
      const db = makeMockDb({ selects: [[{ ...INVITE_ROW, acceptedAt: new Date() }]] });
      const svc = createTeamService(db as any);
      await expect(svc.acceptInvite("abc123", "uid", "new@acme.com"))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it("throws 410 when invite is expired", async () => {
      const db = makeMockDb({ selects: [[{ ...INVITE_ROW, expiresAt: PAST }]] });
      const svc = createTeamService(db as any);
      await expect(svc.acceptInvite("abc123", "uid", "new@acme.com"))
        .rejects.toMatchObject({ statusCode: 410 });
    });

    it("throws 403 when accepting user email does not match invite email", async () => {
      const db = makeMockDb({ selects: [[INVITE_ROW]] });
      const svc = createTeamService(db as any);
      await expect(svc.acceptInvite("abc123", "uid", "wrong@email.com"))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it("is case-insensitive for email comparison", async () => {
      const db = makeMockDb({ selects: [[INVITE_ROW], []], withInsert: true, withUpdate: true });
      const svc = createTeamService(db as any);
      await expect(svc.acceptInvite("abc123", "uid", "NEW@ACME.COM")).resolves.toBeDefined();
    });

    it("inserts member and marks acceptedAt on happy path", async () => {
      const db = makeMockDb({ selects: [[INVITE_ROW], []], withInsert: true, withUpdate: true });
      const svc = createTeamService(db as any);
      const result = await svc.acceptInvite("abc123", "uid", "new@acme.com");
      expect(result).toMatchObject({ workspaceId: "ws-1", role: "member" });
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("skips insert when user is already a workspace member", async () => {
      const db = makeMockDb({
        selects: [[INVITE_ROW], [{ userId: "uid" }]],
        withUpdate: true,
      });
      const svc = createTeamService(db as any);
      const result = await svc.acceptInvite("abc123", "uid", "new@acme.com");
      expect(result).toMatchObject({ workspaceId: "ws-1", role: "member" });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateMemberRole", () => {
    it("throws 403 when requesting role is not owner", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(
        svc.updateMemberRole("ws-1", "user-2", "member", "user-1", "admin")
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("throws 400 when trying to change own role", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(
        svc.updateMemberRole("ws-1", "owner-uid", "member", "owner-uid", "owner")
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("throws 400 when trying to promote to owner", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(
        svc.updateMemberRole("ws-1", "user-2", "owner", "owner-uid", "owner")
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("throws 404 when target member not found", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      await expect(
        svc.updateMemberRole("ws-1", "ghost", "member", "owner-uid", "owner")
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 403 when trying to change the role of an existing owner", async () => {
      const db = makeMockDb({ selects: [[{ role: "owner" }]] });
      const svc = createTeamService(db as any);
      await expect(
        svc.updateMemberRole("ws-1", "owner-2", "admin", "owner-uid", "owner")
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("updates role and returns new assignment on happy path", async () => {
      const db = makeMockDb({ selects: [[{ role: "member" }]], withUpdate: true });
      const svc = createTeamService(db as any);
      const result = await svc.updateMemberRole("ws-1", "user-2", "admin", "owner-uid", "owner");
      expect(result).toEqual({ userId: "user-2", role: "admin" });
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("removeMember", () => {
    it("throws 403 when requesting role is member", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(
        svc.removeMember("ws-1", "user-2", "user-1", "member")
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("throws 400 when trying to remove self", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(
        svc.removeMember("ws-1", "owner-uid", "owner-uid", "owner")
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("throws 404 when target not found", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      await expect(
        svc.removeMember("ws-1", "ghost", "owner-uid", "owner")
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 403 when trying to remove the workspace owner", async () => {
      const db = makeMockDb({ selects: [[{ role: "owner" }]] });
      const svc = createTeamService(db as any);
      await expect(
        svc.removeMember("ws-1", "other-owner", "owner-uid", "owner")
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("deletes the member on happy path (owner removes admin)", async () => {
      const db = makeMockDb({ selects: [[{ role: "admin" }]], withDelete: true });
      const svc = createTeamService(db as any);
      await expect(
        svc.removeMember("ws-1", "user-2", "owner-uid", "owner")
      ).resolves.toBeUndefined();
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it("admin can remove a member", async () => {
      const db = makeMockDb({ selects: [[{ role: "member" }]], withDelete: true });
      const svc = createTeamService(db as any);
      await expect(
        svc.removeMember("ws-1", "user-2", "admin-uid", "admin")
      ).resolves.toBeUndefined();
    });
  });

  describe("revokeInvite", () => {
    it("throws 403 when requesting role is member", async () => {
      const db = makeMockDb();
      const svc = createTeamService(db as any);
      await expect(svc.revokeInvite("ws-1", "inv-1", "member"))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it("throws 404 when invite not found in this workspace", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      await expect(svc.revokeInvite("ws-1", "inv-ghost", "owner"))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    it("deletes the invite on happy path", async () => {
      const db = makeMockDb({ selects: [[{ id: "inv-1" }]], withDelete: true });
      const svc = createTeamService(db as any);
      await expect(svc.revokeInvite("ws-1", "inv-1", "owner")).resolves.toBeUndefined();
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it("admin can also revoke invites", async () => {
      const db = makeMockDb({ selects: [[{ id: "inv-1" }]], withDelete: true });
      const svc = createTeamService(db as any);
      await expect(svc.revokeInvite("ws-1", "inv-1", "admin")).resolves.toBeUndefined();
    });

    it("throws HttpError instances (not generic Error)", async () => {
      const db = makeMockDb({ selects: [[]] });
      const svc = createTeamService(db as any);
      const err = await svc.revokeInvite("ws-1", "inv-x", "owner").catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
    });
  });
});
