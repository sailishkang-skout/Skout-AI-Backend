import { sql as dsql } from "drizzle-orm";
import type { Db } from "./client.js";
import { providerForClerkUserId } from "./schema/auth-identities.js";

export type BackfillAuthIdentitiesResult = {
  clerkUserIdCount: number;
  /** Users with clerk_user_id that have matching clerk/stub auth_identities row */
  clerkLinkedIdentityCount: number;
  /** Total rows in auth_identities (may exceed clerk count when users have extra providers) */
  totalIdentityRowCount: number;
};

export async function backfillAuthIdentities(db: Db): Promise<BackfillAuthIdentitiesResult> {
  await db.execute(dsql`
    INSERT INTO auth_identities (
      user_id,
      provider,
      provider_subject,
      email_at_link,
      email_verified_at,
      created_at,
      last_used_at
    )
    SELECT
      u.id,
      CASE WHEN u.clerk_user_id LIKE 'stub:%' THEN 'stub' ELSE 'clerk' END,
      u.clerk_user_id,
      u.email,
      NULL,
      u.created_at,
      u.created_at
    FROM users u
    WHERE u.clerk_user_id IS NOT NULL
    ON CONFLICT (provider, provider_subject) DO NOTHING
  `);

  const countResult = await db.execute<{
    clerk_user_id_count: string;
    clerk_linked_count: string;
    total_identity_count: string;
  }>(dsql`
    SELECT
      (SELECT count(*)::text FROM users WHERE clerk_user_id IS NOT NULL) AS clerk_user_id_count,
      (SELECT count(*)::text
         FROM users u
        WHERE u.clerk_user_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM auth_identities ai
             WHERE ai.user_id = u.id
               AND ai.provider_subject = u.clerk_user_id
               AND ai.provider = CASE WHEN u.clerk_user_id LIKE 'stub:%' THEN 'stub' ELSE 'clerk' END
          )) AS clerk_linked_count,
      (SELECT count(*)::text FROM auth_identities) AS total_identity_count
  `);

  const row = countResult[0] as
    | { clerk_user_id_count: string; clerk_linked_count: string; total_identity_count: string }
    | undefined;
  return {
    clerkUserIdCount: Number(row?.clerk_user_id_count ?? 0),
    clerkLinkedIdentityCount: Number(row?.clerk_linked_count ?? 0),
    totalIdentityRowCount: Number(row?.total_identity_count ?? 0),
  };
}

export { providerForClerkUserId };
