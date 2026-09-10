import { defineConfig } from "vite";
import { resolve } from "node:path";

/** MV3 multi-entry build — outputs to dist/ for Chrome Web Store packaging (R9.6). */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "background.js"),
        "panel-app": resolve(__dirname, "panel-app.js"),
        "content-script": resolve(__dirname, "content-script.js"),
        "linkedin-scrape": resolve(__dirname, "linkedin-scrape.js"),
        "linkedin-bridge": resolve(__dirname, "linkedin-bridge.js"),
        "skout-web-bridge": resolve(__dirname, "skout-web-bridge.js"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
    target: "es2022",
    minify: true,
    sourcemap: true,
  },
});
