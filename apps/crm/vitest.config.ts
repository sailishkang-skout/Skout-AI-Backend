import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/e2e/**"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
