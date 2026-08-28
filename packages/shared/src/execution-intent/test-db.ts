import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import { createDb } from "@skout/db";

const DEFAULT_TEST_DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";

let loaded = false;
function ensureEnvLoaded() {
  if (loaded) return;
  loaded = true;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
  for (const candidate of [path.join(root, ".env"), path.join(root, ".env.local")]) {
    dotenvConfig({ path: candidate, override: false });
  }
}

/** Returns a real Postgres connection for integration tests, or null if none is configured —
 * matching apps/api/src/test/setup.ts's fallback convention so these tests skip cleanly in
 * environments without a test database instead of failing. */
export function getTestDb() {
  ensureEnvLoaded();
  const url = process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  if (!url) return null;
  return createDb(url);
}

export function hasTestDb(): boolean {
  ensureEnvLoaded();
  return Boolean(process.env.DATABASE_URL) || Boolean(DEFAULT_TEST_DATABASE_URL);
}
