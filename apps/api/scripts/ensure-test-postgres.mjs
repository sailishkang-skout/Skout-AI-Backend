/**
 * Prepares the Postgres that the route integration tests will use: migrations, pending repairs, RBAC seed.
 *
 * Outside CI that is DATABASE_URL (from the environment or .env), else the docker-compose database on port 5434,
 * which is started if needed. A database that is not on this machine is never migrated; the rules are in
 * scripts/test-database.mjs. In CI the database is already running and DATABASE_URL names it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { isPortOpen, resolveTestDatabase } from "../../../scripts/test-database.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function runRbacBackfill(databaseUrl) {
  return spawnSync("pnpm", ["--filter", "@skout/db", "backfill-rbac"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  // In CI, the database is already running, but we still need to run migrations
  const migrate = spawnSync("pnpm", ["db:migrate"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env },
  });
  
  if (migrate.status !== 0) {
    process.exit(migrate.status ?? 1);
  }
  
  const applyPending = spawnSync("pnpm", ["--filter", "@skout/db", "exec", "tsx", "src/apply-pending.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env },
  });
  if (applyPending.status !== 0) process.exit(applyPending.status ?? 1);
  const backfill = runRbacBackfill(process.env.DATABASE_URL);
  process.exit(backfill.status === 0 ? 0 : backfill.status ?? 1);
}
const envFiles = [".env", ".env.local"]
  .map((name) => ({ name, file: path.join(repoRoot, name) }))
  .filter(({ file }) => existsSync(file))
  .map(({ name, file }) => ({ name, values: dotenv.parse(readFileSync(file)) }));
const target = resolveTestDatabase(process.env, envFiles);
const DATABASE_URL = target.url;

if (!target.local) {
  console.warn(
    `ensure-test-postgres: ${target.label} (from ${target.source}) is not on this machine, so it was NOT migrated. ` +
      "Tests that use it expect its schema to be up to date."
  );
  process.exit(0);
}

function dockerAvailable() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

// Start docker compose only for its own database, and only when nothing is serving it already: starting it from a
// second checkout creates another container that cannot take the port.
if (target.compose && !(await isPortOpen(target.host, target.port))) {
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
}

console.log(`ensure-test-postgres: migrating ${target.label} (from ${target.source})`);

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

if (applyPending.status !== 0) process.exit(applyPending.status ?? 1);
const backfill = runRbacBackfill(DATABASE_URL);
process.exit(backfill.status === 0 ? 0 : backfill.status ?? 1);