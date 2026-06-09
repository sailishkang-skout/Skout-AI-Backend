import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolveDatabaseUrl, resolvePostgresSsl } from "./database-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional: load .env for local `pnpm db:migrate` (dotenv is dev-only, not in ECS image).
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // ECS/task inject DATABASE_HOST + DATABASE_PASSWORD directly.
}

const databaseUrl = resolveDatabaseUrl();
const migrationsFolder =
  process.env.MIGRATIONS_FOLDER ?? path.resolve(__dirname, "../drizzle");

const ssl = resolvePostgresSsl();
const sql = postgres(databaseUrl, { max: 1, ...(ssl ? { ssl } : {}) });
const db = drizzle(sql);

try {
  console.log(`Applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied successfully");
} finally {
  await sql.end();
}
