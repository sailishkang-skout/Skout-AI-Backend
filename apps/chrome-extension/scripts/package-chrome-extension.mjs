#!/usr/bin/env node
/** Package Chrome extension for Web Store upload (R9.7). */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const store = join(root, "store-build");

const LOCAL_HOST_PATTERNS = [
  "http://localhost:3000/*",
  "http://127.0.0.1:3000/*",
  "http://localhost:3001/*",
  "http://127.0.0.1:3001/*",
];

const PRODUCTION_DEFAULTS = {
  webUrl: "https://www.skoutai.io",
  apiUrl: "https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com",
};

/** Bundled by Vite — referenced as dist/<file> in the store manifest. */
const VITE_ENTRIES = new Set([
  "linkedin-scrape.js",
  "linkedin-bridge.js",
  "content-script.js",
  "skout-web-bridge.js",
]);

/** Loaded as plain scripts alongside bundled entries. */
const RAW_CONTENT_SCRIPTS = ["linkedin-search-scrape.js", "linkedin-outreach.js"];

/** Side panel + shared modules copied to store root. */
const ROOT_MODULES = [
  "api.js",
  "auth.js",
  "debug.js",
  "lists-cache.js",
  "skout-urls.js",
  "tab-utils.js",
  "linkedin-profile.js",
  "storage-throttle.js",
  "sidepanel.js",
  ...RAW_CONTENT_SCRIPTS,
];

function stripLocalhostPatterns(patterns = []) {
  return patterns.filter((pattern) => !LOCAL_HOST_PATTERNS.includes(pattern));
}

function resolveContentScriptPath(file) {
  if (VITE_ENTRIES.has(file)) return `dist/${file}`;
  return file;
}

function patchStoreBackground(source) {
  // Vite minifies install defaults to `{apiUrl:dt,webUrl:_,...}` — replace with prod URLs.
  const installDefaults = `{apiUrl:"${PRODUCTION_DEFAULTS.apiUrl}",webUrl:"${PRODUCTION_DEFAULTS.webUrl}",stubEmail:"extension@example.com",onboardingComplete:!1}`;
  const replaced = source.replace(
    /\{apiUrl:[^,]+,webUrl:[^,]+,stubEmail:"extension@example\.com",onboardingComplete:!1\}/,
    installDefaults
  );
  if (replaced === source) {
    throw new Error("Failed to patch store background install defaults — rebuild and retry.");
  }
  return replaced;
}

execSync("pnpm build", { cwd: root, stdio: "inherit" });

rmSync(store, { recursive: true, force: true });
mkdirSync(store, { recursive: true });

for (const file of ["sidepanel.html", "manifest.json", "panel.css", "icons"]) {
  cpSync(join(root, file), join(store, file), { recursive: true });
}
for (const js of ROOT_MODULES) {
  cpSync(join(root, js), join(store, js));
}

const manifest = JSON.parse(readFileSync(join(store, "manifest.json"), "utf8"));
manifest.background.service_worker = "dist/background.js";
manifest.content_scripts = manifest.content_scripts.map((cs) => ({
  ...cs,
  js: cs.js.map(resolveContentScriptPath),
  matches: stripLocalhostPatterns(cs.matches),
}));
manifest.host_permissions = stripLocalhostPatterns(manifest.host_permissions ?? []);
manifest.externally_connectable = {
  matches: stripLocalhostPatterns(manifest.externally_connectable?.matches ?? []),
};
delete manifest.optional_host_permissions;
manifest.side_panel.default_path = "sidepanel.html";

writeFileSync(join(store, "manifest.json"), JSON.stringify(manifest, null, 2));

cpSync(dist, join(store, "dist"), { recursive: true });

const bundledBackground = readFileSync(join(dist, "background.js"), "utf8");
writeFileSync(join(store, "dist", "background.js"), patchStoreBackground(bundledBackground));

if (!existsSync(join(store, "dist", "panel-app.js"))) {
  throw new Error("Missing dist/panel-app.js — background service worker import will fail.");
}

const zipName = `skout-extension-v${manifest.version}.zip`;
execSync(`cd "${store}" && zip -r "../${zipName}" .`, { stdio: "inherit" });
console.log(`Created ${join(root, zipName)}`);
console.log("Store defaults:", PRODUCTION_DEFAULTS);
