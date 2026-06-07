import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadEnv();
  const app = await buildApp(config);

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Skout API listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
