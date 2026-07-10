/**
 * One-off script to apply migration 0015_outbound_webhooks directly.
 * Use when Drizzle's migration runner is out of sync with DB state.
 * Run: DATABASE_SSL=require pnpm --filter @skout/db exec tsx src/apply-0015.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { resolveDatabaseUrl, resolvePostgresSsl } from "./database-url.js";

try { const { config } = await import("dotenv"); config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") }); } catch {}

const databaseUrl = resolveDatabaseUrl();
const ssl = resolvePostgresSsl();
const sql = postgres(databaseUrl, { max: 1, ...(ssl ? { ssl } : {}) });

const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/0015_outbound_webhooks.sql");
const migration = readFileSync(migrationPath, "utf8");

console.log("Applying 0015_outbound_webhooks...");
try {
  await sql.unsafe(migration);
  console.log("Done.");
} catch (err) {
  console.error("Migration failed:", err);
  process.exit(1);
} finally {
  await sql.end();
}
