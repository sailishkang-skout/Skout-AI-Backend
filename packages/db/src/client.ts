import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolvePostgresSsl } from "./database-url.js";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(connectionString: string) {
  const ssl = resolvePostgresSsl();
  const sql = postgres(connectionString, {
    max: 10,
    ...(ssl ? { ssl } : {}),
  });
  const db = drizzle(sql, { schema });

  return { db, sql };
}
