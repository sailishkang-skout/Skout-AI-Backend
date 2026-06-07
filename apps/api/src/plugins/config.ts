import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Env;
  }
}

export const configPlugin = fp(async (app: FastifyInstance, config: Env) => {
  app.decorate("config", config);
});
