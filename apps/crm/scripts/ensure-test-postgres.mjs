/**
 * Ensures local Postgres is up for CRM route integration tests (docker-compose port 5434).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";

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
  process.exit(0);
}

const migrate = spawnSync("pnpm", ["db:migrate"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL },
});

process.exit(migrate.status === 0 ? 0 : migrate.status ?? 1);
