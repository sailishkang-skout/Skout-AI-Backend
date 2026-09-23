import { createDb, schema } from "@skout/db";
import { normalizeEmail } from "@skout/shared";
import { loadEnv } from "../src/config/env.js";
import { createHash } from "node:crypto";

async function detectDuplicateEmails() {
  console.log("🔍 Starting duplicate email detection...\n");

  // Load environment variables and create database connection
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is not set in environment variables");
    process.exit(1);
  }
  const { db } = createDb(env.DATABASE_URL);

  // Get all user emails
  const allUsers = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users);

  console.log(`Total users found: ${allUsers.length}\n`);

  // Group by normalized email to find duplicates
  const normalizedEmailMap = new Map<string, typeof allUsers>();
  
  for (const user of allUsers) {
    if (!user.email) continue;
    
    const normalized = normalizeEmail(user.email);
    const existing = normalizedEmailMap.get(normalized) || [];
    existing.push(user);
    normalizedEmailMap.set(normalized, existing);
  }

  // Find all normalized emails with more than one user
  const duplicates: Array<{ normalizedEmail: string; count: number; users: typeof allUsers }> = [];
  let totalDuplicateUsers = 0;

  for (const [normalizedEmail, users] of normalizedEmailMap.entries()) {
    if (users.length > 1) {
      duplicates.push({
        normalizedEmail,
        count: users.length,
        users,
      });
      totalDuplicateUsers += users.length;
    }
  }

  // Generate report (no PII, just counts and safe metadata)
  console.log("📊 Duplicate Email Report");
  console.log("========================\n");
  console.log(`Total normalized emails with duplicates: ${duplicates.length}`);
  console.log(`Total users involved in duplicates: ${totalDuplicateUsers}`);
  console.log(`Unique email addresses (normalized): ${normalizedEmailMap.size}\n`);

  if (duplicates.length > 0) {
    console.log("⚠️  Collisions detected (counts only, no PII):");
    console.log("-------------------------------------------");
    for (const dup of duplicates) {
      // Hash the normalized email to avoid exposing PII in logs
      const hashed = createHash('sha256').update(dup.normalizedEmail).digest('hex').slice(0, 16);
      console.log(`  Hash: ${hashed} | Affected users: ${dup.count}`);
    }
    console.log("\n❌ Migration cannot proceed safely until these collisions are resolved.");
    process.exit(1);
  } else {
    console.log("✅ No duplicate emails found!");
    console.log("\n🚀 Migration can proceed to normalize all emails and add the unique index.");
    process.exit(0);
  }
}

detectDuplicateEmails().catch((err) => {
  console.error("❌ Error detecting duplicates:", err);
  process.exit(1);
});