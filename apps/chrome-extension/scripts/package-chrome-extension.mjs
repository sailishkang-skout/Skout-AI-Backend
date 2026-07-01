#!/usr/bin/env node
/** Package Chrome extension for Web Store upload (R9.7). */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const store = join(root, "store-build");

execSync("pnpm build", { cwd: root, stdio: "inherit" });

mkdirSync(store, { recursive: true });
for (const file of ["sidepanel.html", "manifest.json", "icons"]) {
  cpSync(join(root, file), join(store, file), { recursive: true });
}
for (const js of ["api.js", "auth.js", "debug.js", "lists-cache.js", "skout-urls.js", "tab-utils.js", "linkedin-profile.js"]) {
  cpSync(join(root, js), join(store, js));
}

const manifest = JSON.parse(readFileSync(join(store, "manifest.json"), "utf8"));
manifest.background.service_worker = "background.js";
manifest.content_scripts = manifest.content_scripts.map((cs) => ({
  ...cs,
  js: cs.js.map((f) => (f.endsWith(".js") ? `dist/${f}` : f)),
}));
manifest.side_panel.default_path = "sidepanel.html";
writeFileSync(join(store, "manifest.json"), JSON.stringify(manifest, null, 2));

cpSync(dist, join(store, "dist"), { recursive: true });

const zipName = `skout-extension-v${manifest.version}.zip`;
execSync(`cd "${store}" && zip -r "../${zipName}" .`, { stdio: "inherit" });
console.log(`Created ${join(root, zipName)}`);
