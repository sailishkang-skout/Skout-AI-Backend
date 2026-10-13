#!/usr/bin/env node
/**
 * Chrome extension package validation (ENR-06). Run after `pnpm --filter
 * @skout/chrome-extension package:store`.
 *
 * Checks the store build that would be uploaded:
 *   - one version everywhere: package.json, manifest.json, the store manifest, the zip name
 *   - the version is a plain x.y.z, and is higher than the base branch's when extension code
 *     changed (a warning on a pull request; an error with --release)
 *   - Manifest V3; permissions and host permissions are within the reviewed lists below, so a
 *     new permission cannot ship without this file being changed in the same review
 *   - no localhost or development origin anywhere in the store manifest
 *   - every script the manifest names is in the build
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "apps/chrome-extension";
const STORE = join(ROOT, "store-build");
const release = process.argv.includes("--release");

/** Reviewed in ENR-01. Adding to either list is a security review, not a build fix. */
const ALLOWED_PERMISSIONS = new Set(["storage", "activeTab", "scripting", "sidePanel", "tabs", "alarms"]);
const ALLOWED_HOSTS = new Set([
  "https://www.linkedin.com/*",
  "https://linkedin.com/*",
  "https://www.skoutai.io/*",
  "https://skoutai.io/*",
  "https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/*",
]);
const DEV_ORIGIN = /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local\b|:300[0-9]/;

const errors = [];
const warnings = [];
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const numeric = (version) => version.split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const pkg = json(join(ROOT, "package.json"));
const source = json(join(ROOT, "manifest.json"));
if (!/^\d+\.\d+\.\d+$/.test(source.version)) errors.push(`manifest.json version "${source.version}" is not x.y.z.`);
if (pkg.version !== source.version) errors.push(`package.json is ${pkg.version} but manifest.json is ${source.version}. They must match.`);

if (!existsSync(join(STORE, "manifest.json"))) {
  errors.push(`${STORE}/manifest.json is missing. Run: pnpm --filter @skout/chrome-extension package:store`);
} else {
  const store = json(join(STORE, "manifest.json"));
  if (store.version !== source.version) errors.push(`The store build is ${store.version} but the source manifest is ${source.version}. Rebuild the package.`);
  if (store.manifest_version !== 3) errors.push(`The store manifest is Manifest V${store.manifest_version}; it must be V3.`);
  for (const permission of store.permissions ?? []) {
    if (!ALLOWED_PERMISSIONS.has(permission)) errors.push(`Permission "${permission}" is not in the reviewed list.`);
  }
  for (const host of store.host_permissions ?? []) {
    if (!ALLOWED_HOSTS.has(host)) errors.push(`Host permission "${host}" is not in the reviewed list.`);
  }
  if (store.optional_host_permissions) errors.push("The store manifest still has optional_host_permissions (development origins).");
  const origins = [
    ...(store.host_permissions ?? []),
    ...(store.externally_connectable?.matches ?? []),
    ...(store.content_scripts ?? []).flatMap((script) => script.matches ?? []),
  ];
  for (const origin of origins) if (DEV_ORIGIN.test(origin)) errors.push(`Development origin "${origin}" is in the store manifest.`);
  const scripts = [store.background?.service_worker, store.side_panel?.default_path, ...(store.content_scripts ?? []).flatMap((script) => script.js ?? [])].filter(Boolean);
  for (const script of scripts) if (!existsSync(join(STORE, script))) errors.push(`The manifest names ${script}, which is not in the store build.`);
  const background = store.background?.service_worker && existsSync(join(STORE, store.background.service_worker)) ? readFileSync(join(STORE, store.background.service_worker), "utf8") : "";
  if (/apiUrl:"http:\/\/(localhost|127\.0\.0\.1)/.test(background)) errors.push("The store background script still defaults to a localhost API URL.");
  if (!existsSync(join(ROOT, `skout-extension-v${source.version}.zip`))) errors.push(`skout-extension-v${source.version}.zip was not produced.`);
}

// Version must move when shipped code moves.
const base = process.env.GITHUB_BASE_REF;
if (base) {
  try {
    execSync(`git fetch origin ${base} --depth=1`, { stdio: "ignore" });
    const baseVersion = JSON.parse(execSync(`git show origin/${base}:${ROOT}/manifest.json`, { encoding: "utf8" })).version;
    const changed = execSync(`git diff --name-only origin/${base}...HEAD -- ${ROOT}`, { encoding: "utf8" })
      .split("\n")
      .filter((file) => file && !/\/(test|store-build|dist|node_modules)\/|\.zip$|README\.md$|\.test\.js$/.test(file));
    if (changed.length && !newer(source.version, baseVersion)) {
      const message = `Extension code changed (${changed.length} file(s)) but the version is still ${source.version} (base: ${baseVersion}). Bump manifest.json and package.json before release.`;
      (release ? errors : warnings).push(message);
    }
  } catch {
    warnings.push(`Could not compare the extension version with ${base}.`);
  }
}

for (const warning of warnings) console.log(`::warning title=Chrome extension::${warning}`);
if (errors.length) {
  console.error("Chrome extension package validation FAILED.\n");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`Chrome extension package OK: v${source.version}${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`);
