import { createRequire } from "node:module";
import { isConfiguredSecret } from "./keys.js";

const require = createRequire(import.meta.url);

let initialized = false;

/**
 * Optional Datadog APM via dd-trace. No-op when DD_API_KEY is missing/invalid.
 * Requires Datadog Agent reachable at DD_AGENT_HOST (sidecar on ECS, optional locally).
 */
export function initDatadogTracer(): boolean {
  if (initialized) return true;
  if (!isConfiguredSecret(process.env.DD_API_KEY)) return false;

  try {
    const ddTrace = require("dd-trace") as {
      init: (opts: Record<string, unknown>) => unknown;
    };
    ddTrace.init({
      service: process.env.DD_SERVICE ?? process.env.SERVICE_NAME ?? "skout-api",
      env: process.env.DD_ENV ?? process.env.NODE_ENV ?? "development",
      version: process.env.DD_VERSION ?? process.env.SERVICE_VERSION,
      hostname: process.env.DD_AGENT_HOST ?? "localhost",
      port: Number(process.env.DD_TRACE_AGENT_PORT ?? "8126"),
      logInjection: true,
      startupLogs: false,
      profiling: false,
      reportHostname: true,
    });
    initialized = true;
    return true;
  } catch {
    return false;
  }
}
