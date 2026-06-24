import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

for (const name of [".env", ".env.local"]) {
  config({ path: path.join(repoRoot, name) });
}

/** Load repo `.env` then resolve Postgres URL (DATABASE_URL or HOST+PASSWORD). */
export function requireDatabaseUrl(): string {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const host = env.DATABASE_HOST;
  const password = env.DATABASE_PASSWORD;
  if (!host || !password) {
    throw new Error(
      "Database not configured: add DATABASE_URL to the repo root .env (see .env.example — postgresql://skout:skout@localhost:5434/skout)"
    );
  }

  const port = env.DATABASE_PORT ?? "5432";
  const user = env.DATABASE_USER ?? "skout";
  const database = env.DATABASE_NAME ?? "skout";
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}
