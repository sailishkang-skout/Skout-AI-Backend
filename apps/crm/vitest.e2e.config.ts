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
    include: ["src/e2e/**/*.e2e.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 60000,
    hookTimeout: 90000,
  },
});
