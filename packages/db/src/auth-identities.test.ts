import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import * as schema from "./schema/index.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { backfillAuthIdentities } from "./auth-identities-backfill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // optional
}

const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.DATABASE_HOST);

describe.skipIf(!hasDatabase)("auth_identities (AUTH-BE-01)", () => {
  let db: Db;
  let sql: ReturnType<typeof createDb>["sql"];
  const suffix = Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const created = createDb(resolveDatabaseUrl());
    db = created.db;
    sql = created.sql;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("backfill is idempotent and row count matches users.clerk_user_id", async () => {
    const clerkId = `user_test_clerk_${suffix}`;
    const stubId = `stub:backfill-${suffix}@test.com`;

    const [clerkUser] = await db
      .insert(schema.users)
      .values({
        email: `clerk-backfill-${suffix}@example.com`,
        clerkUserId: clerkId,
        fullName: "Clerk Backfill",
      })
      .returning({ id: schema.users.id });

    const [stubUser] = await db
      .insert(schema.users)
      .values({
        email: `stub-backfill-${suffix}@example.com`,
        clerkUserId: stubId,
        fullName: "Stub Backfill",
      })
      .returning({ id: schema.users.id });

    const first = await backfillAuthIdentities(db);
    expect(first.clerkLinkedIdentityCount).toBe(first.clerkUserIdCount);

    const identitiesAfterFirst = await db
      .select()
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.userId, clerkUser!.id));
    expect(identitiesAfterFirst).toHaveLength(1);
    expect(identitiesAfterFirst[0]?.provider).toBe("clerk");
    expect(identitiesAfterFirst[0]?.providerSubject).toBe(clerkId);

    const stubIdentity = await db
      .select()
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.userId, stubUser!.id));
    expect(stubIdentity[0]?.provider).toBe("stub");

    const second = await backfillAuthIdentities(db);
    expect(second.clerkLinkedIdentityCount).toBe(first.clerkLinkedIdentityCount);
    expect(second.clerkUserIdCount).toBe(first.clerkUserIdCount);
    expect(second.clerkLinkedIdentityCount).toBe(second.clerkUserIdCount);
  });

  it("allows two providers on one user", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `multi-provider-${suffix}@example.com`,
        clerkUserId: `user_multi_${suffix}`,
      })
      .returning({ id: schema.users.id });

    await db.insert(schema.authIdentities).values({
      userId: user!.id,
      provider: "clerk",
      providerSubject: `user_multi_${suffix}`,
      emailAtLink: `multi-provider-${suffix}@example.com`,
    });

    await db.insert(schema.authIdentities).values({
      userId: user!.id,
      provider: "google",
      providerSubject: `google-subject-${suffix}`,
      emailAtLink: `multi-provider-${suffix}@example.com`,
    });

    const rows = await db
      .select({ provider: schema.authIdentities.provider })
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.userId, user!.id));

    expect(rows.map((r) => r.provider).sort()).toEqual(["clerk", "google"]);
  });

  it("rejects the same (provider, subject) on two users", async () => {
    const subject = `shared-subject-${suffix}`;

    const [userA] = await db
      .insert(schema.users)
      .values({ email: `user-a-${suffix}@example.com`, clerkUserId: `clerk_a_${suffix}` })
      .returning({ id: schema.users.id });
    const [userB] = await db
      .insert(schema.users)
      .values({ email: `user-b-${suffix}@example.com`, clerkUserId: `clerk_b_${suffix}` })
      .returning({ id: schema.users.id });

    await db.insert(schema.authIdentities).values({
      userId: userA!.id,
      provider: "clerk",
      providerSubject: subject,
      emailAtLink: `user-a-${suffix}@example.com`,
    });

    await expect(
      db.insert(schema.authIdentities).values({
        userId: userB!.id,
        provider: "clerk",
        providerSubject: subject,
        emailAtLink: `user-b-${suffix}@example.com`,
      })
    ).rejects.toThrow();
  });
});
