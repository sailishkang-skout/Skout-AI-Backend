/**
 * Ensures Postgres is up for route integration tests.
 *
 * Prefers a locally-running Postgres (whatever DATABASE_URL resolves to from .env —
 * e.g. a native install on 5432) over the docker-compose container (5434) when one is
 * reachable, since a developer's own local instance is the source of truth they're
 * actively working against. Falls back to docker-compose only when no local Postgres
 * answers, so this still works out of the box for anyone without one installed.
 *
 * CI already runs `pnpm db:migrate` once before `pnpm test` against DATABASE_URL (:5432).
 * Skip compose + migrate in CI to avoid racing CRM pretest on __drizzle_migrations.
 */
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  process.exit(0);
}

try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(repoRoot, ".env") });
} catch {
  // dotenv is dev-only; if it's missing there's nothing local to load anyway.
}

const DOCKER_DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";

/** Plain TCP connect check — avoids needing the `postgres` package as a direct
 * dependency of this workspace just for a reachability probe. */
function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function localPostgresReachable() {
  const url = process.env.DATABASE_URL;
  if (!url || url === DOCKER_DATABASE_URL) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return tcpReachable(parsed.hostname, Number(parsed.port) || 5432);
}

function dockerAvailable() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

function runMigrations(databaseUrl) {
  const migrate = spawnSync("pnpm", ["db:migrate"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: databaseUrl },
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
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  process.exit(applyPending.status === 0 ? 0 : applyPending.status ?? 1);
}

if (await localPostgresReachable()) {
  console.log(`ensure-test-postgres: using local Postgres at ${process.env.DATABASE_URL} (skipping docker-compose).`);
  runMigrations(process.env.DATABASE_URL);
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

runMigrations(DOCKER_DATABASE_URL);
