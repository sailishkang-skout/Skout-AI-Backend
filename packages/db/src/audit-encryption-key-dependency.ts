/**
 * AUTH-ADI-02 — prove INTEGRATION_ENCRYPTION_KEY / HUBSPOT_CLIENT_SECRET don't
 * silently depend on CLERK_SECRET_KEY as a fallback crypto key.
 *
 * Read-only: attempts decryption of every encrypted row with the current key
 * only, and separately checks whether any row decrypts ONLY under
 * CLERK_SECRET_KEY. Never writes to the DB, never prints plaintext or key
 * material — counts per table only.
 *
 * Usage:
 *   INTEGRATION_ENCRYPTION_KEY=... CLERK_SECRET_KEY=... \
 *     pnpm --filter @skout/db audit-encryption-key-dependency
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDecipheriv, createHash } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { inboxes } from "./schema/inbox.js";
import { workspaceIntegrations } from "./schema/integrations.js";
import { calendarConnections } from "./schema/crm.js";
import { automationSecrets } from "./schema/automations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // env may be injected
}

const ALGO = "aes-256-gcm";

// Mirrors @skout/shared's integration-crypto — inlined to avoid a
// packages/db -> @skout/shared -> @skout/db circular workspace dependency.
function decryptSecret(payload: string, secret: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("invalid_encrypted_payload");
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

const currentKey = process.env.INTEGRATION_ENCRYPTION_KEY;
const clerkKey = process.env.CLERK_SECRET_KEY;

if (!currentKey || currentKey === "replace-me") {
  console.error("INTEGRATION_ENCRYPTION_KEY is missing or still the CDK placeholder ('replace-me').");
  process.exit(1);
}
if (!clerkKey) {
  console.error("CLERK_SECRET_KEY not set — cannot test the Clerk-key-fallback hypothesis.");
  process.exit(1);
}

type Result = { ok: number; clerkOnly: number; undecryptable: number };

function classify(payload: string | null | undefined, result: Result): void {
  if (!payload) return;
  try {
    decryptSecret(payload, currentKey!);
    result.ok++;
    return;
  } catch {
    // falls through to clerk-key check
  }
  try {
    decryptSecret(payload, clerkKey!);
    result.clerkOnly++;
  } catch {
    result.undecryptable++;
  }
}

const databaseUrl = resolveDatabaseUrl();
const { db, sql } = createDb(databaseUrl);

const report: Record<string, Result> = {
  "automation_secrets.encrypted_value": { ok: 0, clerkOnly: 0, undecryptable: 0 },
  "workspace_integrations.encrypted_api_key": { ok: 0, clerkOnly: 0, undecryptable: 0 },
  "inboxes.smtp_password_encrypted": { ok: 0, clerkOnly: 0, undecryptable: 0 },
  "inboxes.oauth_access_token_encrypted": { ok: 0, clerkOnly: 0, undecryptable: 0 },
  "inboxes.oauth_refresh_token_encrypted": { ok: 0, clerkOnly: 0, undecryptable: 0 },
  "calendar_connections.oauth_access_token_encrypted": { ok: 0, clerkOnly: 0, undecryptable: 0 },
  "calendar_connections.oauth_refresh_token_encrypted": { ok: 0, clerkOnly: 0, undecryptable: 0 },
};

try {
  const secretRows = await db
    .select({ value: automationSecrets.encryptedValue })
    .from(automationSecrets);
  for (const row of secretRows) classify(row.value, report["automation_secrets.encrypted_value"]);

  const integrationRows = await db
    .select({ value: workspaceIntegrations.encryptedApiKey })
    .from(workspaceIntegrations)
    .where(isNotNull(workspaceIntegrations.encryptedApiKey));
  for (const row of integrationRows) classify(row.value, report["workspace_integrations.encrypted_api_key"]);

  const inboxRows = await db
    .select({
      smtp: inboxes.smtpPasswordEncrypted,
      access: inboxes.oauthAccessTokenEncrypted,
      refresh: inboxes.oauthRefreshTokenEncrypted,
    })
    .from(inboxes);
  for (const row of inboxRows) {
    classify(row.smtp, report["inboxes.smtp_password_encrypted"]);
    classify(row.access, report["inboxes.oauth_access_token_encrypted"]);
    classify(row.refresh, report["inboxes.oauth_refresh_token_encrypted"]);
  }

  const calendarRows = await db
    .select({
      access: calendarConnections.oauthAccessTokenEncrypted,
      refresh: calendarConnections.oauthRefreshTokenEncrypted,
    })
    .from(calendarConnections);
  for (const row of calendarRows) {
    classify(row.access, report["calendar_connections.oauth_access_token_encrypted"]);
    classify(row.refresh, report["calendar_connections.oauth_refresh_token_encrypted"]);
  }

  let anyClerkOnly = false;
  console.log("AUTH-ADI-02 — encryption key dependency audit (counts only, no plaintext)\n");
  for (const [table, r] of Object.entries(report)) {
    console.log(
      `${table}: ok=${r.ok} clerk_key_only=${r.clerkOnly} undecryptable=${r.undecryptable}`
    );
    if (r.clerkOnly > 0) anyClerkOnly = true;
  }

  if (anyClerkOnly) {
    console.log(
      "\nFINDING: at least one row only decrypts with CLERK_SECRET_KEY. Do not proceed with " +
        "AUTH-BE-07 (removing the Clerk-key fallback) until these rows are re-encrypted under " +
        "INTEGRATION_ENCRYPTION_KEY. Tell Sahil Sawal."
    );
    process.exit(2);
  }
  console.log("\nNo rows depend on CLERK_SECRET_KEY for decryption.");
} finally {
  await sql.end();
}
