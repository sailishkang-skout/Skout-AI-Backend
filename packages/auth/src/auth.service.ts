import { schema } from "@skout/db";
import type { Db } from "@skout/db";
import { providerForClerkUserId } from "@skout/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { normalizeEmail } from "@skout/shared";
import { HttpError } from "./http.js";
import { linkAuthIdentity } from "./link-auth-identity.js";

export interface ProvisionResult {
  userId: string;
  userEmail: string;
  workspaceId: string;
  role: string;
}

export type ResolveOrProvisionInput = {
  provider: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
};

type UserRow = {
  id: string;
  email: string;
  status: string;
  isBlocked: boolean;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function legacyClerkUserIdColumn(provider: string, subject: string): string | null {
  if (provider === "clerk" || provider === "stub") return subject;
  return null;
}

function storageEmail(input: ResolveOrProvisionInput): string {
  if (input.email) return normalizeEmail(input.email);
  const encoded = encodeURIComponent(`${input.provider}:${input.subject}`);
  return `unverified+${encoded}@accounts.skout.internal`;
}

function normalizeInput(
  input: ResolveOrProvisionInput | string,
  email?: string,
  fullName?: string,
  emailVerified = true
): ResolveOrProvisionInput {
  if (typeof input !== "string") return input;
  return {
    provider: providerForClerkUserId(input),
    subject: input,
    email,
    emailVerified,
    name: fullName,
  };
}

type UserMatch = { user: UserRow; matchedBy: "identity" | "clerk" | "email" };

async function findExistingUser(tx: Tx, input: ResolveOrProvisionInput): Promise<UserMatch | null> {
  const [byIdentity] = await tx
    .select({
      id: schema.users.id,
      email: schema.users.email,
      status: schema.users.status,
      isBlocked: schema.users.isBlocked,
    })
    .from(schema.authIdentities)
    .innerJoin(schema.users, eq(schema.authIdentities.userId, schema.users.id))
    .where(
      and(
        eq(schema.authIdentities.provider, input.provider),
        eq(schema.authIdentities.providerSubject, input.subject)
      )
    )
    .limit(1);

  if (byIdentity) return { user: byIdentity, matchedBy: "identity" };

  const legacyClerkId = legacyClerkUserIdColumn(input.provider, input.subject);
  if (legacyClerkId) {
    const [byClerk] = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        status: schema.users.status,
        isBlocked: schema.users.isBlocked,
      })
      .from(schema.users)
      .where(eq(schema.users.clerkUserId, legacyClerkId))
      .limit(1);
    if (byClerk) return { user: byClerk, matchedBy: "clerk" };
  }

  if (input.emailVerified && input.email) {
    const [byEmail] = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        status: schema.users.status,
        isBlocked: schema.users.isBlocked,
      })
      .from(schema.users)
      .where(eq(schema.users.email, normalizeEmail(input.email)))
      .limit(1);
    if (byEmail) return { user: byEmail, matchedBy: "email" };
  }

  return null;
}

export async function resolveOrProvisionUser(
  db: Db,
  input: ResolveOrProvisionInput | string,
  email?: string,
  fullName?: string,
  legacyOptions?: { emailVerified?: boolean }
): Promise<ProvisionResult> {
  const resolved = normalizeInput(input, email, fullName, legacyOptions?.emailVerified ?? true);
  const storedEmail = storageEmail(resolved);
  const displayName = resolved.name ?? resolved.email ?? storedEmail;
  const legacyClerkId = legacyClerkUserIdColumn(resolved.provider, resolved.subject);
  const emailVerifiedAt = resolved.emailVerified ? new Date() : null;

  return db.transaction(async (tx) => {
    const existing = await findExistingUser(tx, resolved);

    let userId: string;
    let userEmail: string;
    let userStatus: string;
    let userBlocked: boolean;

    if (existing) {
      ({ id: userId, email: userEmail, status: userStatus, isBlocked: userBlocked } = existing.user);

      const shouldBackfillClerkId =
        existing.matchedBy === "email" &&
        resolved.emailVerified &&
        resolved.email &&
        legacyClerkId;

      if (shouldBackfillClerkId) {
        await tx
          .update(schema.users)
          .set({ clerkUserId: legacyClerkId, fullName: displayName, updatedAt: new Date() })
          .where(eq(schema.users.id, userId));
      }
    } else {
      const [created] = await tx
        .insert(schema.users)
        .values({
          email: storedEmail,
          fullName: displayName,
          clerkUserId: legacyClerkId,
          status: "active",
          isBlocked: false,
        })
        .onConflictDoUpdate({
          target: schema.users.email,
          set: {
            clerkUserId: legacyClerkId,
            fullName: displayName,
            updatedAt: new Date(),
          },
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

    if (userStatus !== "active" || userBlocked) {
      throw new HttpError("Account is inactive or blocked", 403);
    }

    await linkAuthIdentity(
      tx,
      userId,
      resolved.provider,
      resolved.subject,
      userEmail,
      emailVerifiedAt
    );

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

    const now = new Date();
    const inviteEmail = normalizeEmail(resolved.email ?? userEmail);
    const pendingInvites = await tx
      .select({
        id: schema.workspaceInvites.id,
        workspaceId: schema.workspaceInvites.workspaceId,
        role: schema.workspaceInvites.role,
      })
      .from(schema.workspaceInvites)
      .where(
        and(
          eq(schema.workspaceInvites.email, inviteEmail),
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
      storedEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-") || "workspace";
    const uniqueSlug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({ name: `${displayName}'s Workspace`, slug: uniqueSlug })
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
  tx: Tx,
  userId: string,
  email: string,
  currentWorkspaceId: string
): Promise<void> {
  const now = new Date();
  const normalizedEmail = normalizeEmail(email);
  const pending = await tx
    .select({
      id: schema.workspaceInvites.id,
      workspaceId: schema.workspaceInvites.workspaceId,
      role: schema.workspaceInvites.role,
    })
    .from(schema.workspaceInvites)
    .where(
      and(
        eq(schema.workspaceInvites.email, normalizedEmail),
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
      await tx.insert(schema.workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId,
        role: invite.role,
      });
    }

    await tx.update(schema.workspaceInvites).set({ acceptedAt: now }).where(eq(schema.workspaceInvites.id, invite.id));
  }
}