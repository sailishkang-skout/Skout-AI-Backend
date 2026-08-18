import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for drizzle-kit");
}

// `out` points at drizzle-baseline/, NOT drizzle/ — see drizzle-baseline/README.md for why.
// Short version: drizzle/meta/ is missing snapshots for most of this project's migration
// history (only 0000-0003, 0007 (empty), and 0008 ever existed; 0004-0006 and 0009-0045 have
// none), which made `drizzle-kit generate` unusable — it validates every journal-referenced
// snapshot up front, not just the latest one. Nothing about drizzle/*.sql or its journal was
// touched (the runtime migrator in src/migrate.ts reads those directly, has its own hardcoded
// path, and never looks at meta/ snapshots at all) — every already-applied migration on every
// environment is completely unaffected by this. drizzle-baseline/ is a fresh, accurate,
// self-consistent snapshot lineage seeded from the real current schema, so `pnpm db:generate`
// works again for authoring the *next* schema change; see the README for the one manual step
// that change then needs (copy + renumber into drizzle/, same as migration 0045).
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle-baseline",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
