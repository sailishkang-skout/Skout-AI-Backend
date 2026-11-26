/**
 * Which Postgres does a local `pnpm test` prepare?
 *
 * The same one the tests then use (apps/api/src/test/setup.ts): DATABASE_URL from the environment, else from the
 * repo's .env, then .env.local, else the docker-compose database on port 5434. The pretest scripts used to hardcode
 * that last one, so tests pointed at a throwaway database still migrated the developer's own.
 *
 * One rule is stricter than the tests: only a database on this machine is ever migrated. A .env may hold a shared,
 * remote database, and preparing tests must not change its schema.
 *
 * No dependencies: the caller reads and parses the .env files.
 */
import net from "node:net";

export const DEFAULT_TEST_DATABASE_URL = "postgresql://skout:skout@localhost:5434/skout";
/** The host port docker-compose.yml publishes Postgres on. */
export const COMPOSE_POSTGRES_PORT = 5434;

const THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
/** Also local, but reached through Docker, so compose cannot be what serves them on 5434. */
const DOCKER_NAMES = new Set(["host.docker.internal", "postgres"]);

/**
 * @param {Record<string, string | undefined>} env the process environment
 * @param {Array<{ name: string, values: Record<string, string> }>} envFiles parsed .env files, highest priority first
 */
export function resolveTestDatabase(env, envFiles = []) {
  let url = env.DATABASE_URL;
  let source = "DATABASE_URL";
  // Like dotenv without override: a file only counts when the variable is not set at all.
  if (url === undefined) {
    const file = envFiles.find((f) => f.values.DATABASE_URL !== undefined);
    url = file?.values.DATABASE_URL;
    if (file) source = file.name;
  }
  if (!url) {
    url = DEFAULT_TEST_DATABASE_URL;
    source = "the default";
  }
  return { url, source, ...describe(url) };
}

/** Host facts about a connection string. `label` never contains the user name or password. */
function describe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { host: "", port: 0, local: false, compose: false, label: "(a DATABASE_URL that cannot be read)" };
  }
  const host = parsed.hostname;
  const port = Number(parsed.port) || 5432;
  // A ?host= parameter overrides the host in the address, so it has to be local too.
  const override = parsed.searchParams.get("host");
  const isLocal = (h) => THIS_MACHINE.has(h) || DOCKER_NAMES.has(h);
  const local = /^postgres(ql)?:$/.test(parsed.protocol) && isLocal(host) && (override === null || isLocal(override));
  return {
    host,
    port,
    local,
    compose: local && override === null && THIS_MACHINE.has(host) && port === COMPOSE_POSTGRES_PORT,
    label: `${override ?? host}:${port}${parsed.pathname}`,
  };
}

/** True when something accepts TCP connections there. */
export function isPortOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
