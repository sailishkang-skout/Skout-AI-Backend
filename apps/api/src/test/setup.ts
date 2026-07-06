/**
 * Vitest global setup — route integration tests need Postgres; unit tests do not.
 * Probes the local docker-compose port and configures DATABASE_URL only when reachable.
 * For remote databases (e.g. Supabase), DATABASE_URL is trusted without probing.
 */
import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";

// Load .env files so DATABASE_URL is available when vitest skips dotenv loading.
function loadDotEnv() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../../.env.local"),
  ];
  for (const p of candidates) {
    try {
      const content = readFileSync(p, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      // file not found — skip
    }
  }
}

loadDotEnv();

const DEFAULT_TEST_DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";

const dbEnvKeys = [
  "DATABASE_URL",
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_NAME",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
];

function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
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

function isRemoteHost(hostname: string): boolean {
  return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
}

async function postgresReachable() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const { hostname, port } = new URL(url);
      // Remote hosts (e.g. Supabase) are trusted as-is — no TCP probe needed.
      if (isRemoteHost(hostname)) return true;
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
