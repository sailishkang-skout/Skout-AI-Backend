import type { Env } from "../config/env.js";

export function createTransactionalMailer(config: Env) {
  return {
    baseUrl: config.INVITE_BASE_URL ?? config.FRONTEND_URL ?? "http://localhost:3000",
  };
}
