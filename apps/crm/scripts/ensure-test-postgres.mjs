/**
 * Ensures local Postgres is up for CRM route integration tests (docker-compose port 5434).
 *
 * Does NOT run migrations — API pretest (local) or CI workflow owns `pnpm db:migrate`
 * so parallel `pnpm -r test` cannot race on __drizzle_migrations.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
