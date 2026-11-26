/**
 * Ensures local Postgres is up for CRM route integration tests (docker-compose port 5434).
 *
 * Does nothing when DATABASE_URL (from the environment or .env) names another database, or when something already
 * serves the compose port; the rules are in scripts/test-database.mjs.
 *
 * Does NOT run migrations — API pretest (local) or CI workflow owns `pnpm db:migrate`
 * so parallel `pnpm -r test` cannot race on __drizzle_migrations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { isPortOpen, resolveTestDatabase } from "../../../scripts/test-database.mjs";

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const envFiles = [".env", ".env.local"]
  .map((name) => ({ name, file: path.join(repoRoot, name) }))
  .filter(({ file }) => existsSync(file))
  .map(({ name, file }) => ({ name, values: dotenv.parse(readFileSync(file)) }));
const target = resolveTestDatabase(process.env, envFiles);

if (!target.compose || (await isPortOpen(target.host, target.port))) {
  process.exit(0);
}

function dockerAvailable() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

if (!dockerAvailable()) {
  process.exit(0);
}

const up = spawnSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.local.yml", "up", "-d", "--wait", "postgres"],
  { cwd: repoRoot, stdio: "inherit" }
);

if (up.status !== 0) {
  console.warn("ensure-test-postgres: Postgres did not become healthy — CRM integration tests may skip DB.");
}

process.exit(0);
