/**
 * Vitest global setup — route integration tests need Postgres; unit tests do not.
 * Loads .env so the Supabase URL is available, then probes to confirm reachability.
 * Falls back to the local docker-compose default when DATABASE_URL is not set.
 */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

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
} else {
  for (const key of dbEnvKeys) {
    delete process.env[key];
  }
}
