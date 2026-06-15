import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // CI runs tests before `dist/` exists — resolve workspace package to source.
      "@skout/scraper-contracts": path.resolve(
        root,
        "../../../packages/scraper-contracts/src/index.ts"
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
