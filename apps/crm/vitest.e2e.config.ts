import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 60000,
    hookTimeout: 90000,
  },
});
