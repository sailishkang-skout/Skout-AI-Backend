import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { createDb, type Db } from "@skout/db";

declare module "fastify" {
  interface FastifyInstance {
    db: Db | null;
    /** Test hook: called for every SQL statement. Null in production. */
    onDbQuery: ((query: string) => void) | null;
  }
}

export const dbPlugin = fp(async (app: FastifyInstance) => {
  const url = app.config.DATABASE_URL;

  if (!url) {
    app.decorate("db", null);
    app.log.warn("DATABASE_URL not set — database client disabled");
    return;
  }

  const { db, sql } = createDb(url, { onQuery: app.onDbQuery ?? undefined });

  try {
    await sql`SELECT 1`;
    app.log.info("Database connected successfully");
  } catch (err) {
    app.log.error({ err }, "Database connection failed");
    throw err;
  }

  app.decorate("db", db);

  // Waits up to 5s for open queries, then closes what is left. Without a timeout, connections a
  // database outage broke are never released and close() (graceful shutdown) never finishes.
  app.addHook("onClose", async () => {
    await sql.end({ timeout: DB_SHUTDOWN_TIMEOUT_SECONDS });
  });
});

/** Seconds a pool waits for open queries on shutdown before closing its connections. */
export const DB_SHUTDOWN_TIMEOUT_SECONDS = 5;
