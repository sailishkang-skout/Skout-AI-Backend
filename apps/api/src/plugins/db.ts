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
  app.decorate("db", db);

  app.addHook("onClose", async () => {
    await sql.end();
  });
});
