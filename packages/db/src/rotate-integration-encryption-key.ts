/**
 * §11.1 — re-encrypt rows that use INTEGRATION_ENCRYPTION_KEY so the key can
 * actually rotate on the cadence in docs/secrets-rotation-policy.md.
 *
 * Usage:
 *   OLD_INTEGRATION_ENCRYPTION_KEY=... NEW_INTEGRATION_ENCRYPTION_KEY=... \
 *     pnpm --filter @skout/db rotate-integration-encryption-key
 *
 * During cutover, set INTEGRATION_ENCRYPTION_KEY=new and
 * INTEGRATION_ENCRYPTION_KEY_PREVIOUS=old, and call decryptSecretWithFallback
 * at decrypt sites until this script finishes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { inboxes } from "./schema/inbox.js";
import { workspaceIntegrations } from "./schema/integrations.js";
import { calendarConnections } from "./schema/crm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // env may be injected
}

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptSecret(payload: string, secret: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("invalid_encrypted_payload");
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Decrypt preferring old key; if already on new key, return null (= skip). */
function reencrypt(payload: string | null | undefined, oldKey: string, newKey: string): string | null {
  if (!payload) return null;
  try {
    const plain = decryptSecret(payload, oldKey);
    return encryptSecret(plain, newKey);
  } catch {
    try {
      decryptSecret(payload, newKey);
      return null;
    } catch {
      throw new Error("ciphertext decrypts with neither old nor new key");
    }
  }
}

const oldKey = process.env.OLD_INTEGRATION_ENCRYPTION_KEY ?? process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS;
const newKey = process.env.NEW_INTEGRATION_ENCRYPTION_KEY ?? process.env.INTEGRATION_ENCRYPTION_KEY;
if (!oldKey || !newKey) {
  console.error(
    "Require OLD_INTEGRATION_ENCRYPTION_KEY (or INTEGRATION_ENCRYPTION_KEY_PREVIOUS) and NEW_INTEGRATION_ENCRYPTION_KEY (or INTEGRATION_ENCRYPTION_KEY)."
  );
  process.exit(1);
}
if (oldKey === newKey) {
  console.error("Old and new keys are identical — nothing to rotate.");
  process.exit(1);
}

const databaseUrl = resolveDatabaseUrl();
const { db, sql } = createDb(databaseUrl);

let updated = 0;
let skipped = 0;
let failed = 0;

try {
  const inboxRows = await db
    .select({
      id: inboxes.id,
      smtp: inboxes.smtpPasswordEncrypted,
      access: inboxes.oauthAccessTokenEncrypted,
      refresh: inboxes.oauthRefreshTokenEncrypted,
    })
    .from(inboxes);

  for (const row of inboxRows) {
    const patch: Partial<{
      smtpPasswordEncrypted: string;
      oauthAccessTokenEncrypted: string;
      oauthRefreshTokenEncrypted: string;
    }> = {};
    for (const [field, value] of [
      ["smtpPasswordEncrypted", row.smtp],
      ["oauthAccessTokenEncrypted", row.access],
      ["oauthRefreshTokenEncrypted", row.refresh],
    ] as const) {
      try {
        const next = reencrypt(value, oldKey, newKey);
        if (next) patch[field] = next;
        else if (value) skipped++;
      } catch (err) {
        failed++;
        console.error(`[inboxes.${field}] failed id=${row.id}`, err);
      }
    }
    if (Object.keys(patch).length) {
      await db.update(inboxes).set(patch).where(eq(inboxes.id, row.id));
      updated += Object.keys(patch).length;
    }
  }

  const integrationRows = await db
    .select({ id: workspaceIntegrations.id, value: workspaceIntegrations.encryptedApiKey })
    .from(workspaceIntegrations)
    .where(isNotNull(workspaceIntegrations.encryptedApiKey));

  for (const row of integrationRows) {
    try {
      const next = reencrypt(row.value, oldKey, newKey);
      if (!next) {
        skipped++;
        continue;
      }
      await db
        .update(workspaceIntegrations)
        .set({ encryptedApiKey: next })
        .where(eq(workspaceIntegrations.id, row.id));
      updated++;
    } catch (err) {
      failed++;
      console.error(`[workspace_integrations] failed id=${row.id}`, err);
    }
  }

  const calendarRows = await db
    .select({
      id: calendarConnections.id,
      access: calendarConnections.oauthAccessTokenEncrypted,
      refresh: calendarConnections.oauthRefreshTokenEncrypted,
    })
    .from(calendarConnections);

  for (const row of calendarRows) {
    const patch: Partial<{
      oauthAccessTokenEncrypted: string;
      oauthRefreshTokenEncrypted: string;
    }> = {};
    for (const [field, value] of [
      ["oauthAccessTokenEncrypted", row.access],
      ["oauthRefreshTokenEncrypted", row.refresh],
    ] as const) {
      try {
        const next = reencrypt(value, oldKey, newKey);
        if (next) patch[field] = next;
        else if (value) skipped++;
      } catch (err) {
        failed++;
        console.error(`[calendar_connections.${field}] failed id=${row.id}`, err);
      }
    }
    if (Object.keys(patch).length) {
      await db.update(calendarConnections).set(patch).where(eq(calendarConnections.id, row.id));
      updated += Object.keys(patch).length;
    }
  }

  console.log(`Rotation complete: updated=${updated} skipped_already_new=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(2);
} finally {
  await sql.end();
}
