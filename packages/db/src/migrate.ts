import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
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
const migrationsSchema = "drizzle";
const migrationsTable = "__drizzle_migrations";

const ssl = resolvePostgresSsl();
const sql = postgres(databaseUrl, { max: 1, ...(ssl ? { ssl } : {}) });

try {
  console.log(`Applying migrations from ${migrationsFolder}`);
  const migrations = readMigrationFiles({ migrationsFolder });

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${migrationsSchema}"`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${migrationsSchema}"."${migrationsTable}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // drizzle-orm's built-in migrator (drizzle-orm/postgres-js/migrator) only compares
  // each migration's folderMillis against the SINGLE latest recorded created_at — it
  // never checks whether a given migration actually has a row. That watermark breaks
  // as soon as the journal is edited after the fact (renumbering/inserting entries to
  // resolve a cross-branch collision, which this repo's history shows happens
  // routinely): a migration whose `when` falls at or below an already-advanced
  // watermark is silently skipped forever, with no error, even though its SQL never
  // ran. That's exactly what happened to 0088_signal_activation_checked_at after the
  // Sept 7 2026 journal repair (2f227fd) — "Migrations applied successfully" every
  // deploy, column never created. Track by exact created_at membership instead, so a
  // migration is considered applied iff it has its own row — order-independent and
  // safe against future journal edits.
  const appliedRows = await sql.unsafe(
    `SELECT created_at FROM "${migrationsSchema}"."${migrationsTable}"`
  );
  const applied = new Set(appliedRows.map((r) => String(r.created_at)));

  let appliedCount = 0;
  for (const migration of migrations) {
    if (applied.has(String(migration.folderMillis))) continue;

    await sql.begin(async (tx) => {
      for (const stmt of migration.sql) {
        if (!stmt.trim()) continue;
        await tx.unsafe(stmt);
      }
      await tx.unsafe(
        `INSERT INTO "${migrationsSchema}"."${migrationsTable}" ("hash", "created_at") VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis]
      );
    });
    appliedCount++;
  }
  console.log(`Migrations applied successfully (${appliedCount} newly applied)`);
} finally {
  await sql.end();
}
