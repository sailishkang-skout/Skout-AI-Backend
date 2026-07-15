import { randomBytes } from "node:crypto";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { and, count, eq, gt, isNull, ne } from "drizzle-orm";
import { HttpError } from "../utils/http.js";

export type WorkspaceRole = "owner" | "admin" | "member";

const VALID_ROLES: WorkspaceRole[] = ["owner", "admin", "member"];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_MEMBER_LIMIT = 50;

function assertRole(role: string): asserts role is WorkspaceRole {
  if (!VALID_ROLES.includes(role as WorkspaceRole)) {
    throw new HttpError(`Invalid role "${role}". Must be owner, admin, or member.`, 400);
  }
}

function requireMinRole(requestingRole: string | undefined, ...allowed: WorkspaceRole[]) {
  if (!requestingRole || !allowed.includes(requestingRole as WorkspaceRole)) {
    throw new HttpError(`Requires role: ${allowed.join(" or ")}`, 403);
  }
}

export function createTeamService(db: Db) {
  return {
    async listMembers(workspaceId: string) {
      const rows = await db
        .select({
          userId: schema.workspaceMembers.userId,
          role: schema.workspaceMembers.role,
          joinedAt: schema.workspaceMembers.joinedAt,
          email: schema.users.email,
          fullName: schema.users.fullName,
        })
        .from(schema.workspaceMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));

      return rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        fullName: r.fullName,
        role: r.role as WorkspaceRole,
        joinedAt: r.joinedAt.toISOString(),
      }));
    },

    async listPendingInvites(workspaceId: string) {
      const now = new Date();
      const rows = await db
        .select()
        .from(schema.workspaceInvites)
        .where(
          and(
            eq(schema.workspaceInvites.workspaceId, workspaceId),
            isNull(schema.workspaceInvites.acceptedAt),
            gt(schema.workspaceInvites.expiresAt, now)
          )
        );

      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role as WorkspaceRole,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      }));
    },

    async inviteMember(
      workspaceId: string,
      invitedByUserId: string,
      email: string,
      _role: WorkspaceRole,
      requestingRole: string | undefined
    ) {
      requireMinRole(requestingRole, "owner", "admin");

      // All invited users get "member" role — no exceptions
      const role: WorkspaceRole = "member";

      // Enforce workspace member limit (members + pending invites)
      const [memberCount] = await db
        .select({ value: count() })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));

      const now = new Date();
      const [pendingCount] = await db
        .select({ value: count() })
        .from(schema.workspaceInvites)
        .where(
          and(
            eq(schema.workspaceInvites.workspaceId, workspaceId),
            isNull(schema.workspaceInvites.acceptedAt),
            gt(schema.workspaceInvites.expiresAt, now)
          )
        );

      const total = (memberCount?.value ?? 0) + (pendingCount?.value ?? 0);
      if (total >= WORKSPACE_MEMBER_LIMIT) {
        throw new HttpError(
          `Workspace has reached the ${WORKSPACE_MEMBER_LIMIT}-member limit.`,
          409
        );
      }

      // check not already a member
      const [existing] = await db
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, workspaceId),
            eq(schema.users.email, email.toLowerCase())
          )
        )
        .limit(1);

      if (existing) {
        throw new HttpError("This person is already a member of the workspace.", 409);
      }

      // upsert: if a pending invite exists for this email, replace it
      const [pendingForEmail] = await db
        .select({ id: schema.workspaceInvites.id })
        .from(schema.workspaceInvites)
        .where(
          and(
            eq(schema.workspaceInvites.workspaceId, workspaceId),
            eq(schema.workspaceInvites.email, email.toLowerCase()),
            isNull(schema.workspaceInvites.acceptedAt)
          )
        )
        .limit(1);

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

      if (pendingForEmail) {
        await db
          .update(schema.workspaceInvites)
          .set({ role, token, expiresAt, createdAt: now })
          .where(eq(schema.workspaceInvites.id, pendingForEmail.id));
      } else {
        await db.insert(schema.workspaceInvites).values({
          workspaceId,
          invitedByUserId,
          email: email.toLowerCase(),
          role,
          token,
          expiresAt,
        });
      }

      return { token, email: email.toLowerCase(), role, expiresAt };
    },

    async getInviteByToken(token: string) {
      const [invite] = await db
        .select({
          id: schema.workspaceInvites.id,
          workspaceId: schema.workspaceInvites.workspaceId,
          email: schema.workspaceInvites.email,
          role: schema.workspaceInvites.role,
          expiresAt: schema.workspaceInvites.expiresAt,
          acceptedAt: schema.workspaceInvites.acceptedAt,
          workspaceName: schema.workspaces.name,
        })
        .from(schema.workspaceInvites)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceInvites.workspaceId))
        .where(eq(schema.workspaceInvites.token, token))
        .limit(1);

      if (!invite) return null;

      return {
        id: invite.id,
        workspaceId: invite.workspaceId,
        workspaceName: invite.workspaceName,
        email: invite.email,
        role: invite.role as WorkspaceRole,
        expiresAt: invite.expiresAt.toISOString(),
        accepted: !!invite.acceptedAt,
        expired: new Date() > invite.expiresAt,
      };
    },

    async acceptInvite(token: string, userId: string, userEmail: string) {
      const [invite] = await db
        .select()
        .from(schema.workspaceInvites)
        .where(eq(schema.workspaceInvites.token, token))
        .limit(1);

      if (!invite) throw new HttpError("Invite not found.", 404);
      if (invite.acceptedAt) throw new HttpError("This invite has already been accepted.", 409);
      if (new Date() > invite.expiresAt) throw new HttpError("This invite has expired.", 410);

      if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
        throw new HttpError(
          `This invite was sent to ${invite.email}. Sign in with that email to accept.`,
          403
        );
      }

      // idempotent: already a member → just mark accepted
      const [alreadyMember] = await db
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, invite.workspaceId),
            eq(schema.workspaceMembers.userId, userId)
          )
        )
        .limit(1);

      if (!alreadyMember) {
        await db.insert(schema.workspaceMembers).values({
          workspaceId: invite.workspaceId,
          userId,
          role: invite.role,
        });
      }

      await db
        .update(schema.workspaceInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(schema.workspaceInvites.id, invite.id));

      return { workspaceId: invite.workspaceId, role: invite.role as WorkspaceRole };
    },

    async updateMemberRole(
      workspaceId: string,
      targetUserId: string,
      newRole: WorkspaceRole,
      requestingUserId: string,
      requestingRole: string | undefined
    ) {
      requireMinRole(requestingRole, "owner");

      if (targetUserId === requestingUserId) {
        throw new HttpError("You cannot change your own role.", 400);
      }

      assertRole(newRole);
      if (newRole === "owner") {
        throw new HttpError("Cannot promote to owner. Transfer ownership is not supported.", 400);
      }

      const [target] = await db
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, workspaceId),
            eq(schema.workspaceMembers.userId, targetUserId)
          )
        )
        .limit(1);

      if (!target) throw new HttpError("Member not found.", 404);
      if (target.role === "owner") throw new HttpError("Cannot change the role of an owner.", 403);

      await db
        .update(schema.workspaceMembers)
        .set({ role: newRole })
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, workspaceId),
            eq(schema.workspaceMembers.userId, targetUserId)
          )
        );

      return { userId: targetUserId, role: newRole };
    },

    async removeMember(
      workspaceId: string,
      targetUserId: string,
      requestingUserId: string,
      requestingRole: string | undefined
    ) {
      requireMinRole(requestingRole, "owner", "admin");

      if (targetUserId === requestingUserId) {
        throw new HttpError("You cannot remove yourself.", 400);
      }

      const [target] = await db
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, workspaceId),
            eq(schema.workspaceMembers.userId, targetUserId)
          )
        )
        .limit(1);

      if (!target) throw new HttpError("Member not found.", 404);
      if (target.role === "owner") throw new HttpError("Cannot remove the owner.", 403);

      await db
        .delete(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, workspaceId),
            eq(schema.workspaceMembers.userId, targetUserId),
            ne(schema.workspaceMembers.role, "owner")
          )
        );
    },

    async revokeInvite(
      workspaceId: string,
      inviteId: string,
      requestingRole: string | undefined
    ) {
      requireMinRole(requestingRole, "owner", "admin");

      const [invite] = await db
        .select({ id: schema.workspaceInvites.id })
        .from(schema.workspaceInvites)
        .where(
          and(
            eq(schema.workspaceInvites.id, inviteId),
            eq(schema.workspaceInvites.workspaceId, workspaceId)
          )
        )
        .limit(1);

      if (!invite) throw new HttpError("Invite not found.", 404);

      await db
        .delete(schema.workspaceInvites)
        .where(eq(schema.workspaceInvites.id, inviteId));
    },
  };
}
