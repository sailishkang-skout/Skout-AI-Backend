import { schema } from "@skout/db";
import type { Db } from "@skout/db";
import { eq } from "drizzle-orm";
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

      return { userId, userEmail, workspaceId: membership.workspaceId, role: membership.role };
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
