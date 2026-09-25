import { createHash } from "node:crypto";
import { and, eq, gt, or } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

/**
 * AUTH-BE-26 — Hash invite session tokens (isk_) before persisting in DB.
 * Guarantees that no plaintext session tokens exist in the database.
 */
export function hashInviteSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface VerifiedInviteSession {
  userId: string;
  email?: string;
  workspaceId?: string;
  role?: string;
}

/**
 * Verifies an isk_ session token against invite_sessions.
 * Checks against both tokenHash (for new hashed records) and raw token (for legacy rows).
 */
export async function verifyInviteSession(
  db: Db,
  rawToken: string
): Promise<VerifiedInviteSession | null> {
  const tokenHash = hashInviteSessionToken(rawToken);
  const now = new Date();

  const [session] = await db
    .select({ userId: schema.inviteSessions.userId })
    .from(schema.inviteSessions)
    .where(
      and(
        or(
          eq(schema.inviteSessions.token, tokenHash),
          eq(schema.inviteSessions.token, rawToken)
        ),
        gt(schema.inviteSessions.expiresAt, now)
      )
    )
    .limit(1);

  if (!session) return null;

  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, session.userId))
    .limit(1);

  const [membership] = await db
    .select({
      workspaceId: schema.workspaceMembers.workspaceId,
      role: schema.workspaceMembers.role,
    })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, session.userId))
    .limit(1);

  return {
    userId: session.userId,
    email: user?.email,
    workspaceId: membership?.workspaceId,
    role: membership?.role,
  };
}

