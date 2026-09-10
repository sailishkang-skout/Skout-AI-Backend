/**
 * Resolve PostgreSQL connection string from DATABASE_URL or ECS/RDS split env vars.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

  const host = env.DATABASE_HOST;
  const password = env.DATABASE_PASSWORD;
  if (!host || !password) {
    throw new Error(
      "Database URL not configured: set DATABASE_URL or DATABASE_HOST + DATABASE_PASSWORD"
    );
  }

  const port = env.DATABASE_PORT ?? "5432";
  const user = env.DATABASE_USER ?? "skout";
  const database = env.DATABASE_NAME ?? "skout";

  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/** RDS requires SSL; local Docker Postgres does not. */
export function resolvePostgresSsl(
  env: NodeJS.ProcessEnv = process.env
): "require" | false {
  if (env.DATABASE_SSL === "false") return false;
  if (env.DATABASE_SSL === "true" || env.DATABASE_SSL === "require") {
    return "require";
  }

  const url = env.DATABASE_URL;
  if (url?.includes("localhost") || url?.includes("127.0.0.1")) return false;

  const host = env.DATABASE_HOST;
  if (!host || host.includes("localhost") || host === "127.0.0.1") return false;

  return "require";
}
