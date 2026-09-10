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
  dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
}

initDatadogTracer();
initOpenTelemetry();
