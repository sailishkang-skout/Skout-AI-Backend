import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
}

async function main() {
  const config = loadEnv();
  const app = await buildApp(config);

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Skout API listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      app.log.error(
        `Port ${config.PORT} is already in use — stop the other process (often a stray "next dev -p ${config.PORT}") and restart the API`
      );
    } else {
      app.log.error(err);
    }
    process.exit(1);
  }
}

main();
