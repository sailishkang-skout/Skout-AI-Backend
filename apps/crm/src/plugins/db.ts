import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { createDb, type Db } from "@skout/db";

declare module "fastify" {
  interface FastifyInstance {
    db: Db | null;
  }
}

export const dbPlugin = fp(async (app: FastifyInstance) => {
  const url = app.config.DATABASE_URL;

  if (!url) {
    app.decorate("db", null);
    app.log.warn("DATABASE_URL not set — database client disabled");
    return;
  }

  const { db, sql } = createDb(url);

  try {
    await sql`SELECT 1`;
    app.log.info("Database connected successfully");
  } catch (err) {
    app.log.error({ err }, "Database connection failed");
    throw err;
  }

  app.decorate("db", db);

  app.addHook("onClose", async () => {
    await sql.end();
  });
});
