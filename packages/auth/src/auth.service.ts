import { schema } from "@skout/db";
import type { Db } from "@skout/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { HttpError } from "./http.js";

export interface ProvisionResult {
  userId: string;
  userEmail: string;
  workspaceId: string;
  role: string;
}

export async function resolveOrProvisionUser(
  db: Db,
  clerkUserId: string,
  email: string,
  fullName: string
): Promise<ProvisionResult> {
  return db.transaction(async (tx) => {
    const byClerk = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        status: schema.users.status,
        isBlocked: schema.users.isBlocked,
      })
      .from(schema.users)
      .where(eq(schema.users.clerkUserId, clerkUserId))
      .limit(1);

    let userId: string;
    let userEmail: string;
    let userStatus: string;
    let userBlocked: boolean;

    if (byClerk[0]) {
      ({ id: userId, email: userEmail, status: userStatus, isBlocked: userBlocked } = byClerk[0]);
    } else {
      const byEmail = await tx
        .select({
          id: schema.users.id,
          email: schema.users.email,
          status: schema.users.status,
          isBlocked: schema.users.isBlocked,
        })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

      if (byEmail[0]) {
        await tx
          .update(schema.users)
          .set({ clerkUserId, fullName, updatedAt: new Date() })
          .where(eq(schema.users.id, byEmail[0].id));
        ({ id: userId, email: userEmail, status: userStatus, isBlocked: userBlocked } = byEmail[0]);
      } else {
        const [created] = await tx
          .insert(schema.users)
          .values({ email, fullName, clerkUserId, status: "active", isBlocked: false })
          .onConflictDoUpdate({
            target: schema.users.email,
            set: { clerkUserId, fullName, updatedAt: new Date() },
          })
          .returning({
            id: schema.users.id,
            email: schema.users.email,
            status: schema.users.status,
            isBlocked: schema.users.isBlocked,
          });

        if (!created) throw new HttpError("Failed to create user record", 500);
        ({ id: userId, email: userEmail, status: userStatus, isBlocked: userBlocked } = created);
      }
    }

    if (userStatus !== "active" || userBlocked) {
      throw new HttpError("Account is inactive or blocked", 403);
    }

    const [membership] = await tx
      .select({
        workspaceId: schema.workspaceMembers.workspaceId,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .limit(1);

    if (membership) {
      const [balance] = await tx
        .select({ workspaceId: schema.creditBalances.workspaceId })
        .from(schema.creditBalances)
        .where(eq(schema.creditBalances.workspaceId, membership.workspaceId))
        .limit(1);

      if (!balance) {
        await tx.insert(schema.creditBalances).values({ workspaceId: membership.workspaceId, balance: 500 });
        await tx.insert(schema.creditTransactions).values({
          workspaceId: membership.workspaceId,
          amount: 500,
          action: "provision",
        });
      }

      await autoAcceptPendingInvites(tx, userId, userEmail, membership.workspaceId);

      return { userId, userEmail, workspaceId: membership.workspaceId, role: membership.role };
    }

    // No membership yet — check for pending invites before creating a new workspace.
    // If the user arrived via an invite link, accept those invites and join that workspace
    // instead of provisioning a brand-new workspace as owner.
    const now = new Date();
    const pendingInvites = await tx
      .select({
        id: schema.workspaceInvites.id,
        workspaceId: schema.workspaceInvites.workspaceId,
        role: schema.workspaceInvites.role,
      })
      .from(schema.workspaceInvites)
      .where(
        and(
          eq(schema.workspaceInvites.email, email.toLowerCase()),
          isNull(schema.workspaceInvites.acceptedAt),
          gt(schema.workspaceInvites.expiresAt, now)
        )
      );

    if (pendingInvites.length > 0) {
      for (const invite of pendingInvites) {
        await tx
          .insert(schema.workspaceMembers)
          .values({ workspaceId: invite.workspaceId, userId, role: invite.role })
          .onConflictDoNothing();
        await tx
          .update(schema.workspaceInvites)
          .set({ acceptedAt: now })
          .where(eq(schema.workspaceInvites.id, invite.id));
      }

      const primary = pendingInvites[0]!;
      const [balance] = await tx
        .select({ workspaceId: schema.creditBalances.workspaceId })
        .from(schema.creditBalances)
        .where(eq(schema.creditBalances.workspaceId, primary.workspaceId))
        .limit(1);

      if (!balance) {
        await tx.insert(schema.creditBalances).values({ workspaceId: primary.workspaceId, balance: 500 });
        await tx.insert(schema.creditTransactions).values({
          workspaceId: primary.workspaceId,
          amount: 500,
          action: "provision",
        });
      }

      return { userId, userEmail, workspaceId: primary.workspaceId, role: primary.role };
    }

    const slug =
      email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-") || "workspace";
    const uniqueSlug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({ name: `${fullName}'s Workspace`, slug: uniqueSlug })
      .returning({ id: schema.workspaces.id });

    if (!workspace) throw new HttpError("Failed to create workspace", 500);

    await tx.insert(schema.workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: "owner",
    });

    await tx.insert(schema.creditBalances).values({
      workspaceId: workspace.id,
      balance: 500,
    });

    await tx.insert(schema.creditTransactions).values({
      workspaceId: workspace.id,
      amount: 500,
      action: "provision",
    });

    return { userId, userEmail, workspaceId: workspace.id, role: "owner" };
  });
}

async function autoAcceptPendingInvites(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  userId: string,
  email: string,
  currentWorkspaceId: string
): Promise<void> {
  const now = new Date();
  const pending = await tx
    .select({ id: schema.workspaceInvites.id, workspaceId: schema.workspaceInvites.workspaceId, role: schema.workspaceInvites.role })
    .from(schema.workspaceInvites)
    .where(
      and(
        eq(schema.workspaceInvites.email, email.toLowerCase()),
        isNull(schema.workspaceInvites.acceptedAt),
        gt(schema.workspaceInvites.expiresAt, now)
      )
    );

  for (const invite of pending) {
    if (invite.workspaceId === currentWorkspaceId) continue;

    const [alreadyMember] = await tx
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
      await tx.insert(schema.workspaceMembers).values({ workspaceId: invite.workspaceId, userId, role: invite.role });
    }

    await tx.update(schema.workspaceInvites).set({ acceptedAt: now }).where(eq(schema.workspaceInvites.id, invite.id));
  }
}
