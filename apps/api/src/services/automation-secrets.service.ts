import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById } from "@skout/db";
import { encryptSecret, decryptSecretWithFallback } from "@skout/shared";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";

const { automationSecrets } = schema;

function encryptionSecret(config: Env): string {
  return config.INTEGRATION_ENCRYPTION_KEY ?? config.CLERK_SECRET_KEY ?? "dev-integration-encryption-key-change-me";
}

export async function saveAutomationSecret(db: Db, config: Env, workspaceId: string, name: string, value: string) {
  const encryptedValue = encryptSecret(value, encryptionSecret(config));
  const [row] = await db.insert(automationSecrets).values({ workspaceId, name, encryptedValue }).returning();
  return { id: row!.id };
}

export async function resolveAutomationSecret(db: Db, config: Env, workspaceId: string, secretId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(automationSecrets)
    .where(scopedById(automationSecrets, workspaceId, secretId))
    .limit(1);
  if (!row) throw new HttpError("automation_secret_not_found", 404);
  return decryptSecretWithFallback(row.encryptedValue, encryptionSecret(config), config.INTEGRATION_ENCRYPTION_KEY_PREVIOUS);
}

const REDACTED = "[REDACTED]";
/** Secret values shorter than this are excluded from masking — a very short value (e.g. a
 * single-digit test fixture) would cause pathological false-positive redaction of unrelated
 * data (status codes, small numbers-as-strings) elsewhere in a step's input/output. Real API
 * keys/tokens are effectively never this short, so this doesn't weaken the protection in practice. */
const MIN_MASKABLE_SECRET_LENGTH = 8;

/**
 * §8.14 — every plaintext secret value currently configured for a workspace, decrypted once so
 * maskAutomationSecrets can scan a run step's input/output for any of them. Best-effort: a
 * secret that fails to decrypt (e.g. a key rotation edge case) is skipped rather than blocking
 * the whole run-detail response — masking degrades to "can't check this one" for that secret,
 * never to "throw and hide the whole run."
 */
export async function listAutomationSecretValues(db: Db, config: Env, workspaceId: string): Promise<string[]> {
  const rows = await db.select().from(automationSecrets).where(eq(automationSecrets.workspaceId, workspaceId));
  const values: string[] = [];
  for (const row of rows) {
    try {
      const value = decryptSecretWithFallback(row.encryptedValue, encryptionSecret(config), config.INTEGRATION_ENCRYPTION_KEY_PREVIOUS);
      if (value.length >= MIN_MASKABLE_SECRET_LENGTH) values.push(value);
    } catch {
      // Skip — see doc comment above.
    }
  }
  return values;
}

/**
 * §8.14 — recursively redacts any occurrence of a known secret's plaintext value out of an
 * arbitrary JSON-like value (a run step's `input` or `output`). Value-based, not field-based:
 * this catches a leak no matter which node type or object shape it shows up in — a future node
 * handler that carelessly echoes a resolved credential into its output is still caught here,
 * without needing every node author to remember to scrub it themselves. Applied at the service
 * layer so it protects every caller of getRun()/listRuns(), not just one route's response shape.
 */
export function maskAutomationSecrets<T>(value: T, secretValues: string[]): T {
  if (secretValues.length === 0) return value;
  if (typeof value === "string") {
    let masked: string = value;
    for (const secret of secretValues) {
      if (masked.includes(secret)) masked = masked.split(secret).join(REDACTED);
    }
    return masked as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskAutomationSecrets(v, secretValues)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskAutomationSecrets(v, secretValues)])
    ) as unknown as T;
  }
  return value;
}
