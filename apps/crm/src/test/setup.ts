import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
for (const candidate of [path.join(root, ".env"), path.join(root, ".env.local")]) {
  dotenvConfig({ path: candidate, override: false });
}

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

async function defaultTestPostgresReachable() {
  try {
    const { hostname, port } = new URL(DEFAULT_TEST_DATABASE_URL);
    return probePort(hostname, Number(port) || 5432);
  } catch {
    return false;
  }
}

if (await postgresReachable()) {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;
  }
} else if (await defaultTestPostgresReachable()) {
  process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;
} else {
  for (const key of dbEnvKeys) {
    delete process.env[key];
  }
}
