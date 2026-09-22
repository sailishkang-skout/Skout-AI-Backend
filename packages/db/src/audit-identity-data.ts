/**
 * AUTH-ADI-01 — identity data audit across dev / UAT / prod (read-only).
 *
 * Runs the exact queries from the Clerk migration task tickets and prints
 * counts only — no emails, no user IDs, no other PII. Point this at one
 * environment's DATABASE_URL at a time (dev, then UAT, then prod) and record
 * the output in the ADR-0007 appendix.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @skout/db audit-identity-data
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // env may be injected
}

const databaseUrl = resolveDatabaseUrl();
const { sql } = createDb(databaseUrl);

try {
  const [userCounts] = await sql<
    {
      total: string;
      with_clerk_id: string;
      no_clerk_id: string;
      stub_ids: string;
      fake_emails: string;
      inactive: string;
    }[]
  >`
    SELECT count(*) AS total,
           count(clerk_user_id) AS with_clerk_id,
           count(*) FILTER (WHERE clerk_user_id IS NULL) AS no_clerk_id,
           count(*) FILTER (WHERE clerk_user_id LIKE 'stub:%') AS stub_ids,
           count(*) FILTER (WHERE email LIKE '%@clerk.local') AS fake_emails,
           count(*) FILTER (WHERE is_blocked OR status <> 'active') AS inactive
    FROM users;
  `;

  const caseDuplicates = await sql<{ e: string; count: string }[]>`
    SELECT lower(email) AS e, count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
  `;

  const ssoConfigs = await sql<{ status: string; scim_enabled: boolean; count: string }[]>`
    SELECT status, scim_enabled, count(*) FROM workspace_sso_configs GROUP BY 1, 2;
  `;

  const [activeInvites] = await sql<{ count: string }[]>`
    SELECT count(*) FROM invite_sessions WHERE expires_at > now();
  `;

  console.log("AUTH-ADI-01 — identity data audit (counts only, no PII)\n");
  console.log("users:", userCounts);
  console.log("case-duplicate emails (count of colliding groups):", caseDuplicates.length);
  console.log("workspace_sso_configs by status/scim_enabled:", ssoConfigs);
  console.log("active invite_sessions:", activeInvites.count);

  if (Number(userCounts.stub_ids) > 0 || Number(userCounts.fake_emails) > 0 || caseDuplicates.length > 0) {
    console.log(
      "\nFINDING: stub/fake/case-duplicate rows exist — list them as a cleanup item for AUTH-BE-02."
    );
  }
} finally {
  await sql.end();
}
