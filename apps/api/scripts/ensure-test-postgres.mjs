/**
 * Ensures local Postgres is up for route integration tests (docker-compose port 5434).
 *
 * CI already runs `pnpm db:migrate` once before `pnpm test` against DATABASE_URL (:5432).
 * Skip compose + migrate in CI to avoid racing CRM pretest on __drizzle_migrations.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";

function dockerAvailable() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

if (!dockerAvailable()) {
  process.exit(0);
}

// --wait blocks until the postgres healthcheck (pg_isready) passes, avoiding
// the ECONNRESET race where the TCP port opens before Postgres is ready.
const up = spawnSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.local.yml", "up", "-d", "--wait", "postgres"],
  { cwd: repoRoot, stdio: "inherit" }
);

if (up.status !== 0) {
  console.warn("ensure-test-postgres: Postgres did not become healthy — integration tests may skip DB.");
  process.exit(0);
}

const migrate = spawnSync("pnpm", ["db:migrate"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL },
});

if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1);
}

// Idempotent repairs for columns drizzle migrate may skip when journal `when`
// timestamps are stale relative to already-applied migrations.
const applyPending = spawnSync("pnpm", ["--filter", "@skout/db", "exec", "tsx", "src/apply-pending.ts"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL },
});

process.exit(applyPending.status === 0 ? 0 : applyPending.status ?? 1);
