import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
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
    .where(and(eq(automationSecrets.id, secretId), eq(automationSecrets.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new HttpError("automation_secret_not_found", 404);
  return decryptSecretWithFallback(row.encryptedValue, encryptionSecret(config), config.INTEGRATION_ENCRYPTION_KEY_PREVIOUS);
}
