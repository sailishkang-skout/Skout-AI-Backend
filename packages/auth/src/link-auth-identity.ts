import { schema } from "@skout/db";
import type { Db } from "@skout/db";
import { providerForClerkUserId } from "@skout/db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function linkAuthIdentity(
  tx: Tx,
  userId: string,
  provider: string,
  providerSubject: string,
  email: string,
  emailVerifiedAt: Date | null = null
): Promise<void> {
  const now = new Date();

  await tx
    .insert(schema.authIdentities)
    .values({
      userId,
      provider,
      providerSubject,
      emailAtLink: email,
      emailVerifiedAt,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.authIdentities.provider, schema.authIdentities.providerSubject],
      set: {
        userId,
        emailAtLink: email,
        lastUsedAt: now,
        ...(emailVerifiedAt ? { emailVerifiedAt } : {}),
      },
    });
}

/** AUTH-BE-01 — keep auth_identities in sync when linking via clerk_user_id. */
export async function linkAuthIdentityForClerkUserId(
  tx: Tx,
  userId: string,
  clerkUserId: string,
  email: string,
  emailVerifiedAt: Date | null = null
): Promise<void> {
  await linkAuthIdentity(
    tx,
    userId,
    providerForClerkUserId(clerkUserId),
    clerkUserId,
    email,
    emailVerifiedAt
  );
}
