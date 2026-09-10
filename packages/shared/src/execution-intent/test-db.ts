import net from "node:net";
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

// Mirrors apps/api/src/test/setup.ts's reachability probe: a short-timeout TCP connect
// against the parsed DATABASE_URL, so "no DB configured" and "DB configured but unreachable"
// both resolve to a clean skip instead of every query in the suite throwing a connection error.
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

async function isReachable(url: string): Promise<boolean> {
  try {
    const { hostname, port } = new URL(url);
    return await probePort(hostname, Number(port) || 5432);
  } catch {
    return false;
  }
}

/**
 * Returns a real Postgres connection for integration tests, or null if none is reachable.
 *
 * Resolves DATABASE_URL (env-loaded from .env/.env.local, falling back to the local
 * docker-compose default) and probes it with a short-timeout TCP connect before handing
 * back a `Db` handle — matching apps/api/src/test/setup.ts's convention. Callers
 * `await` this at module top level (`const dbHandle = await getTestDb();`) and pass
 * the result to `describe.skipIf(!dbHandle)`, so suites genuinely skip in environments
 * without a reachable test database (e.g. CI without a DB service) instead of failing
 * with a connection error on the first query.
 */
export async function getTestDb() {
  ensureEnvLoaded();
  const url = process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  if (!url) return null;
  if (!(await isReachable(url))) return null;
  return createDb(url);
}

export async function hasTestDb(): Promise<boolean> {
  ensureEnvLoaded();
  const url = process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  if (!url) return false;
  return isReachable(url);
}
