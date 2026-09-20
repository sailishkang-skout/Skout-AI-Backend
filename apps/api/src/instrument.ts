/**
 * Load env + optional telemetry before the rest of the app.
 * dd-trace must initialize before Fastify and other instrumented modules.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { initDatadogTracer, initOpenTelemetry } from "@skout/observability";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV !== "production") {
  // dotenv never overrides an already-set process.env var, so the more specific apps/api/.env
  // must load before the shared root .env for its overrides (e.g. CORS_ORIGIN) to actually win —
  // otherwise this app boots with the root .env's narrower defaults regardless of its own config.
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
}

initDatadogTracer();
initOpenTelemetry();
