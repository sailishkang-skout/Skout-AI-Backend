/**
 * Ensures local Postgres is up for route integration tests (docker-compose port 5434).
 * No-op when Docker is unavailable — vitest setup clears DATABASE_URL in that case.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";

function probePort(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
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

function dockerAvailable() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

async function waitForPostgres(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await probePort("localhost", 5434)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (!dockerAvailable()) {
  process.exit(0);
}

spawnSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.local.yml", "up", "-d", "postgres"],
  { cwd: repoRoot, stdio: "inherit" }
);

if (!(await waitForPostgres())) {
  console.warn("ensure-test-postgres: Postgres did not become ready on :5434 — integration tests may skip DB.");
  process.exit(0);
}

const migrate = spawnSync("pnpm", ["db:migrate"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL },
});

process.exit(migrate.status === 0 ? 0 : migrate.status ?? 1);
