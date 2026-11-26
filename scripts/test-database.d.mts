export const DEFAULT_TEST_DATABASE_URL: string;
export const COMPOSE_POSTGRES_PORT: number;

export interface TestDatabase {
  url: string;
  /** "DATABASE_URL", the name of the .env file, or "the default". */
  source: string;
  host: string;
  port: number;
  /** On this machine, so it is safe to migrate. */
  local: boolean;
  /** Served by docker compose, so it may be started if nothing is listening. */
  compose: boolean;
  /** host:port/database, without credentials. */
  label: string;
}

export function resolveTestDatabase(
  env: Record<string, string | undefined>,
  envFiles?: Array<{ name: string; values: Record<string, string> }>
): TestDatabase;

export function isPortOpen(host: string, port: number, timeoutMs?: number): Promise<boolean>;
