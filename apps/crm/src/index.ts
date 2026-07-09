import { initRootLogger, initSentry } from "@skout/observability";
import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";

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

  const app = await buildApp(config);

  const shutdown = async () => {
    await app.close();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(
      { host: config.HOST, port: config.PORT, service: config.SERVICE_NAME },
      "Skout CRM listening"
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      app.log.error({ port: config.PORT }, `Port ${config.PORT} is already in use`);
    } else {
      app.log.error({ err }, "CRM service failed to start");
    }
    process.exit(1);
  }
}

main();
