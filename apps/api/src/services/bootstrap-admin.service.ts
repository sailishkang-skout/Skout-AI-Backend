import { eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { resolveOrProvisionUser } from "@skout/auth";
import type { Env } from "../config/env.js";
import { checkPasswordPolicy, hashPassword } from "./credential.service.js";

const { users, userCredentials } = schema;

export type BootstrapOutcome = "skipped_not_configured" | "skipped_exists" | "created" | "rejected_policy";

/**
 * Creates the first admin from BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, once. The user
 * is provisioned like a verified signup (own workspace, owner role). If the email already has a
 * password it is never changed, so the env value cannot reset an account; remove the password
 * from the env after the first start. The password is never logged.
 */
export async function bootstrapAdmin(db: Db, config: Pick<Env, "BOOTSTRAP_ADMIN_EMAIL" | "BOOTSTRAP_ADMIN_PASSWORD" | "BOOTSTRAP_ADMIN_NAME">): Promise<BootstrapOutcome> {
  const email = config.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = config.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return "skipped_not_configured";

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    const [cred] = await db.select({ userId: userCredentials.userId }).from(userCredentials).where(eq(userCredentials.userId, existing.id)).limit(1);
    if (cred) return "skipped_exists";
  }
  if (!checkPasswordPolicy(password).ok) return "rejected_policy";

  const hash = await hashPassword(password);
  const user = await resolveOrProvisionUser(db, { provider: "password", subject: email, email, emailVerified: true, name: config.BOOTSTRAP_ADMIN_NAME ?? "Admin" });
  const [row] = await db
    .insert(userCredentials)
    .values({ userId: user.userId, passwordHash: hash.hash, hashAlgo: hash.algo, hashParams: hash.params })
    .onConflictDoNothing({ target: userCredentials.userId })
    .returning({ userId: userCredentials.userId });
  return row ? "created" : "skipped_exists";
}
