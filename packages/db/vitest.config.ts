import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
