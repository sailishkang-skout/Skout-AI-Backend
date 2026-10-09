import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolvePostgresSsl } from "./database-url.js";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(connectionString: string, options: { onQuery?: (query: string) => void } = {}) {
  const ssl = resolvePostgresSsl();
  const sql = postgres(connectionString, {
    max: 10,
    ...(ssl ? { ssl } : {}),
    // Test hook: observe every statement (used to assert query counts on hot routes).
    ...(options.onQuery ? { debug: (_connection: number, query: string) => options.onQuery!(query) } : {}),
  });
  const db = drizzle(sql, { schema });

  return { db, sql };
}
