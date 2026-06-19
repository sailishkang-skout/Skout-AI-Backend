import "./instrument.js";
import { initRootLogger, initSentry } from "@skout/observability";
import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { startCrmExportWorker } from "./workers/crm-export.worker.js";

async function main() {
  const config = loadEnv();

  initRootLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
    version: config.SERVICE_VERSION,
  });

  initSentry({
    dsn: config.SENTRY_DSN,
    service: config.SERVICE_NAME,
    environment: config.NODE_ENV,
    release: config.SERVICE_VERSION,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
  });

  const stopCrmWorker = await startCrmExportWorker(config);

  const app = await buildApp(config);

  const shutdown = async () => {
    await stopCrmWorker();
    await app.close();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(
      { host: config.HOST, port: config.PORT, service: config.SERVICE_NAME },
      "Skout API listening"
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      app.log.error(
        { port: config.PORT },
        `Port ${config.PORT} is already in use — stop the other process and restart the API`
      );
    } else {
      app.log.error({ err }, "API failed to start");
    }
    process.exit(1);
  }
}

main();
