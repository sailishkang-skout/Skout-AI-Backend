/**
 * Vitest global setup — route integration tests need Postgres; unit tests do not.
 * Loads .env so the Supabase URL is available, then probes to confirm reachability.
 * Falls back to the local docker-compose default when DATABASE_URL is not set.
 */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import { afterEach, beforeEach } from "vitest";
import {
  ensureTestAuthHarness,
  grantSystemMemberRole,
  resetTestAuthHarness,
  resolveOrProvisionUser,
} from "@skout/auth";
import { createDb, schema } from "@skout/db";
import { ensureDemoWorkspace } from "../services/demo-workspace.js";

// Load project .env (without overriding any CI-supplied vars) so that
// DATABASE_URL and other secrets are visible to route integration tests.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
for (const candidate of [path.join(root, ".env"), path.join(root, ".env.local")]) {
  dotenvConfig({ path: candidate, override: false });
}

// analytics-events.ts has a module-level loadEnv() cache that bypasses
// per-test app config overrides. Clear external service URLs so that cache
// never tries to connect to services that aren't running in test.
delete process.env.CLICKHOUSE_URL;
delete process.env.AI_SERVICE_URL;
delete process.env.EMAIL_INTEL_SERVICE_URL;
// Fail-closed flags may be true in a developer's .env for local smoke tests;
// integration tests assume shadow/default-off behavior unless a suite opts in.
delete process.env.RBAC_ENFORCEMENT_ENABLED;
delete process.env.CONSENT_ENFORCEMENT_ENABLED;

const DEFAULT_TEST_DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";

const dbEnvKeys = [
  "DATABASE_URL",
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_NAME",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
];

function probePort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function postgresReachable() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const { hostname, port } = new URL(url);
      return probePort(hostname, Number(port) || 5432);
    } catch {
      return false;
    }
  }
  const host = process.env.DATABASE_HOST ?? "localhost";
  const port = Number(process.env.DATABASE_PORT ?? 5434);
  return probePort(host, port);
}

if (await postgresReachable()) {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;
  }

  const { db, sql } = createDb(process.env.DATABASE_URL!);
  try {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const stubEmail = process.env.AUTH_STUB_EMAIL ?? "stub@example.com";
    await ensureDemoWorkspace(db, workspaceId);
    const stubUser = await resolveOrProvisionUser(db, `stub:${stubEmail}`, stubEmail, "Stub User");
    await db
      .insert(schema.workspaceMembers)
      .values({ workspaceId, userId: stubUser.userId, role: "owner" })
      .onConflictDoUpdate({
        target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
        set: { role: "owner" },
      });
    const roleGranted = await grantSystemMemberRole(db, workspaceId, stubUser.userId, "owner");
    if (!roleGranted) throw new Error("Test owner role is not seeded; run the RBAC backfill before tests");
  } finally {
    await sql.end();
  }
} else {
  for (const key of dbEnvKeys) {
    delete process.env[key];
  }
}

beforeEach(() => {
  ensureTestAuthHarness();
});

afterEach(() => {
  resetTestAuthHarness();
});
