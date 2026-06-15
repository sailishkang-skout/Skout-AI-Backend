import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@clerk/backend": path.resolve(root, "src/test/mocks/clerk-backend.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Enrichment and smart-list route tests are deep integration tests that require
    // DB tables (enrichment_jobs, smart_lists) not yet migrated on this branch.
    // Run them separately once db:push is applied from the develop schema.
    exclude: [
      "src/routes/enrichment.routes.test.ts",
      "src/routes/smart-list.routes.test.ts",
    ],
  },
});
