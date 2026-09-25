import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import * as schema from "./schema/index.js";
import { resolveDatabaseUrl } from "./database-url.js";
import {
  importClerkUsers,
  type ClerkExportUser,
} from "./clerk-user-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // optional
}

const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.DATABASE_HOST);

// Standard bcrypt hash for "imported-password-123"
const TEST_BCRYPT_HASH = "$2b$10$QIqUudM2zteZ.aq/tEPbMeNhcBI6Uni.9a.CU/Xda79ELB2G06Die";

describe.skipIf(!hasDatabase)("clerk-user-import (AUTH-BE-21)", () => {
  let db: Db;
  let sql: ReturnType<typeof createDb>["sql"];
  const suffix = Math.random().toString(36).slice(2, 10);
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const created = createDb(resolveDatabaseUrl());
    db = created.db;
    sql = created.sql;
  });

  afterAll(async () => {
    await sql.end();
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await db.delete(schema.userCredentials).where(eq(schema.userCredentials.userId, userId));
      await db.delete(schema.authIdentities).where(eq(schema.authIdentities.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    createdUserIds.length = 0;
  });

  it("handles a synthetic export covering all acceptance scenarios", async () => {
    // 1. User matched by clerk_user_id
    const clerkId1 = `user_match_id_${suffix}`;
    const [u1] = await db
      .insert(schema.users)
      .values({
        email: `u1-${suffix}@example.com`,
        clerkUserId: clerkId1,
        fullName: "User One",
      })
      .returning({ id: schema.users.id, email: schema.users.email });
    createdUserIds.push(u1!.id);

    // 2. User matched by email (has no clerk_user_id yet)
    const email2 = `u2-${suffix}@example.com`;
    const [u2] = await db
      .insert(schema.users)
      .values({
        email: email2,
        clerkUserId: null,
        fullName: "User Two",
      })
      .returning({ id: schema.users.id, email: schema.users.email });
    createdUserIds.push(u2!.id);

    // 5. User with no password hash in Clerk export
    const clerkId5 = `user_nohash_${suffix}`;
    const [u5] = await db
      .insert(schema.users)
      .values({
        email: `u5-${suffix}@example.com`,
        clerkUserId: clerkId5,
        fullName: "User Five",
      })
      .returning({ id: schema.users.id, email: schema.users.email });
    createdUserIds.push(u5!.id);

    // 6. Google-only user
    const clerkId6 = `user_google_${suffix}`;
    const [u6] = await db
      .insert(schema.users)
      .values({
        email: `u6-${suffix}@example.com`,
        clerkUserId: clerkId6,
        fullName: "User Six",
      })
      .returning({ id: schema.users.id, email: schema.users.email });
    createdUserIds.push(u6!.id);

    // 7. Blocked user
    const clerkId7 = `user_blocked_${suffix}`;
    const [u7] = await db
      .insert(schema.users)
      .values({
        email: `u7-${suffix}@example.com`,
        clerkUserId: clerkId7,
        fullName: "User Seven",
        isBlocked: true,
      })
      .returning({ id: schema.users.id, email: schema.users.email });
    createdUserIds.push(u7!.id);

    // Synthetic export data
    const exportUsers: ClerkExportUser[] = [
      // Case 1: Matched by ID, bcrypt hash
      {
        id: clerkId1,
        email_addresses: [
          {
            email_address: `u1-${suffix}@example.com`,
            verification: { status: "verified" },
          },
        ],
        password_digest: TEST_BCRYPT_HASH,
      },
      // Case 2: Matched by verified email (case-insensitive & trimmed)
      {
        id: `user_new_clerk_id_${suffix}`,
        email_addresses: [
          {
            email_address: `  U2-${suffix}@EXAMPLE.com  `,
            verification: { status: "verified" },
          },
        ],
        password_digest: TEST_BCRYPT_HASH,
      },
      // Case 3: No local user in database (should be skipped)
      {
        id: `user_no_local_${suffix}`,
        email_addresses: [
          {
            email_address: `nobody-${suffix}@example.com`,
            verification: { status: "verified" },
          },
        ],
        password_digest: TEST_BCRYPT_HASH,
      },
      // Case 4: Duplicate emails in export (conflicts)
      {
        id: `user_dupe_a_${suffix}`,
        email: `dupe-${suffix}@example.com`,
        email_verified: true,
        password_digest: TEST_BCRYPT_HASH,
      },
      {
        id: `user_dupe_b_${suffix}`,
        email: `dupe-${suffix}@example.com`,
        email_verified: true,
        password_digest: TEST_BCRYPT_HASH,
      },
      // Case 5: No hash (needs reset)
      {
        id: clerkId5,
        email: `u5-${suffix}@example.com`,
        email_verified: true,
        password_digest: null,
      },
      // Case 6: Google-only (has external account subject, no password hash)
      {
        id: clerkId6,
        email: `u6-${suffix}@example.com`,
        email_verified: true,
        external_accounts: [
          {
            provider: "oauth_google",
            provider_user_id: `google_sub_${suffix}`,
          },
        ],
        password_digest: null,
      },
      // Case 7: Blocked user
      {
        id: clerkId7,
        email: `u7-${suffix}@example.com`,
        email_verified: true,
        password_digest: TEST_BCRYPT_HASH,
      },
    ];

    // First test DRY-RUN: verify no changes written
    const dryRunReport = await importClerkUsers(db, exportUsers, { apply: false });
    expect(dryRunReport.dryRun).toBe(true);
    expect(dryRunReport.totalInExport).toBe(8);
    expect(dryRunReport.matched).toBe(5); // u1, u2, u5, u6, u7
    expect(dryRunReport.skipped).toBe(1); // nobody
    expect(dryRunReport.conflicts.length).toBe(2); // dupe_a, dupe_b
    expect(dryRunReport.needsReset).toBe(2); // u5 (no hash), u6 (google-only no hash)
    expect(dryRunReport.created.credentials).toBe(5);
    expect(dryRunReport.created.identities).toBe(9);

    // Confirm nothing written in dry-run
    const [identitiesBefore] = await db
      .select({ count: schema.authIdentities.id })
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.userId, u1!.id));
    expect(identitiesBefore).toBeUndefined();

    // Now test APPLY: changes should be written
    const applyReport = await importClerkUsers(db, exportUsers, { apply: true });
    expect(applyReport.dryRun).toBe(false);
    expect(applyReport.matched).toBe(5);
    expect(applyReport.skipped).toBe(1);
    expect(applyReport.conflicts.length).toBe(2);
    expect(applyReport.needsReset).toBe(2);
    expect(applyReport.created.credentials).toBe(5);
    expect(applyReport.created.identities).toBe(9); // 5 clerk + 1 google + 3 password

    // Verify u1 (matched by ID, bcrypt hash)
    const [cred1] = await db
      .select()
      .from(schema.userCredentials)
      .where(eq(schema.userCredentials.userId, u1!.id));
    expect(cred1?.hashAlgo).toBe("bcrypt");
    expect(cred1?.passwordHash).toBe(TEST_BCRYPT_HASH);
    expect(cred1?.mustReset).toBe(false);

    // Verify u1 has verified password identity for own-auth login
    const [pwId1] = await db
      .select()
      .from(schema.authIdentities)
      .where(
        and(
          eq(schema.authIdentities.userId, u1!.id),
          eq(schema.authIdentities.provider, "password")
        )
      );
    expect(pwId1?.emailVerifiedAt).toBeTruthy();

    // Verify u2 (matched by normalized email)
    const [cred2] = await db
      .select()
      .from(schema.userCredentials)
      .where(eq(schema.userCredentials.userId, u2!.id));
    expect(cred2?.hashAlgo).toBe("bcrypt");
    expect(cred2?.mustReset).toBe(false);

    // Verify u5 (no hash -> must_reset = true)
    const [cred5] = await db
      .select()
      .from(schema.userCredentials)
      .where(eq(schema.userCredentials.userId, u5!.id));
    expect(cred5?.mustReset).toBe(true);

    // Verify u6 (google-only -> google identity + must_reset = true)
    const [googleId6] = await db
      .select()
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.providerSubject, `google_sub_${suffix}`));
    expect(googleId6?.provider).toBe("google");
    expect(googleId6?.userId).toBe(u6!.id);

    // Verify u7 (blocked user imported)
    const [cred7] = await db
      .select()
      .from(schema.userCredentials)
      .where(eq(schema.userCredentials.userId, u7!.id));
    expect(cred7?.hashAlgo).toBe("bcrypt");

    // Acceptance criterion: running twice changes nothing the second time (idempotent)
    const secondApplyReport = await importClerkUsers(db, exportUsers, { apply: true });
    expect(secondApplyReport.created.credentials).toBe(0);
    expect(secondApplyReport.created.identities).toBe(0);
    expect(secondApplyReport.matched).toBe(5);
    expect(secondApplyReport.skipped).toBe(1);
    expect(secondApplyReport.conflicts.length).toBe(2);
  }, 60000);
});
