#!/usr/bin/env node
/**
 * COPS-08: docs/ops/cops-commercial-policy.default.json is the one place the default commercial
 * policy is written. This script copies it into packages/shared so the app can seed the versioned
 * admin config from it. Run it after editing the JSON; a test in packages/shared fails when the
 * two differ. Keys that start with "_" are notes and are left out.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "docs/ops/cops-commercial-policy.default.json";
const TARGET = "packages/shared/src/cops-commercial-policy.default.ts";

export function stripNotes(value) {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, stripNotes(v)]));
  }
  return value;
}

const data = stripNotes(JSON.parse(readFileSync(SOURCE, "utf8")));
writeFileSync(
  TARGET,
  `// Generated from ${SOURCE} by scripts/sync-cops-commercial-policy.mjs. Do not edit by hand.\n` +
    `export const COMMERCIAL_POLICY_DEFAULT_DATA: Record<"approval_policy" | "dunning_policy" | "price_book" | "currency_policy", unknown> = ${JSON.stringify(data, null, 2)};\n`
);
console.log(`Wrote ${TARGET}`);
