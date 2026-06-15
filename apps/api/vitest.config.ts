import { defineConfig } from "vitest/config";

export default defineConfig({
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
