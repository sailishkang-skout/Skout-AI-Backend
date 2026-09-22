import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { backfillAuthIdentities } from "./auth-identities-backfill.js";
import { resolveDatabaseUrl } from "./database-url.js";

/**
 * AUTH-BE-01 — idempotent backfill from users.clerk_user_id into auth_identities.
 * Safe to re-run: uses ON CONFLICT DO NOTHING on (provider, provider_subject).
 *
 * Run: pnpm --filter @skout/db backfill-auth-identities
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // ECS/task inject DATABASE_HOST + DATABASE_PASSWORD directly.
}

const databaseUrl = resolveDatabaseUrl();
const { db, sql } = createDb(databaseUrl);

try {
  const result = await backfillAuthIdentities(db);
  console.log(
    `auth_identities backfill complete: ${result.clerkLinkedIdentityCount}/${result.clerkUserIdCount} clerk/stub identities linked (${result.totalIdentityRowCount} total auth_identities rows).`
  );
  if (result.clerkLinkedIdentityCount !== result.clerkUserIdCount) {
    console.warn(
      "Row count mismatch — investigate users without identities or orphaned identities before deploy."
    );
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
