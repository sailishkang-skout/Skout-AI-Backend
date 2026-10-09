#!/usr/bin/env node
// deploy/hetzner/scripts/generate-secrets.mjs
// Generate the secrets that only exist because we run the stack (AWS is gone, so nothing can be read back),
// and derive the Clerk issuer from the publishable key. Writes a JSON values file for config-from-synth.mjs.
//
//   node deploy/hetzner/scripts/generate-secrets.mjs --values .env --out deploy/hetzner/generated/secrets.json
//
// Fresh start (no customer data), so a brand-new set of keys is correct. Never reuse them across environments.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotenv } from "./config-from-synth.mjs";

/** Clerk publishable keys are `pk_<env>_<base64 of "<frontend api host>$">`; the issuer is https://<host>. */
export function deriveClerkIssuer(publishableKey) {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey ?? "");
  if (!m) throw new Error("Not a Clerk publishable key (expected pk_test_... or pk_live_...)");
  const host = Buffer.from(m[1], "base64").toString("utf8").replace(/\$$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new Error("Clerk publishable key does not decode to a host name");
  return `https://${host}`;
}

export function generateSecrets({ randomHex, authFields }) {
  const provisioningKey = randomHex(32);
  const evidenceToken = randomHex(32);
  return {
    ...authFields,
    // Warm-up tool (>= 32 chars each). The api provisions the tool with the same key it holds.
    ENCRYPTION_KEY: randomHex(32),
    API_KEY_PEPPER: randomHex(32),
    PLATFORM_PROVISIONING_KEY: provisioningKey,
    WARMUP_TOOL_PLATFORM_PROVISIONING_KEY: provisioningKey,
    // Email-intel forwards evidence to the api with a shared token, over the overlay network.
    SKOUT_CANONICAL_EVIDENCE_TOKEN: evidenceToken,
    EMAIL_INTEL_EXTERNAL_API_KEY: evidenceToken,
    SKOUT_CANONICAL_EVIDENCE_URL: "http://api:3001",
    // Webhook secret for the meeting-bot vendor; random until a vendor is configured.
    MEETING_BOT_WEBHOOK_SECRET: randomHex(32),
    // System mail sender, on the domain verified in Postmark.
    SES_FROM_EMAIL: "noreply@skoutai.io",
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
  };
  const valuesFile = opt("values", ".env");
  const outFile = opt("out", "deploy/hetzner/generated/secrets.json");
  const values = parseDotenv(readFileSync(valuesFile, "utf8"));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const authScript = path.resolve(here, "../../../infra/scripts/generate-auth-keys.ts");
  const authFields = JSON.parse(
    execFileSync("npx", ["tsx", authScript, "--json"], { encoding: "utf8", shell: process.platform === "win32" })
  );

  const secrets = generateSecrets({ randomHex: (n) => randomBytes(n).toString("hex"), authFields });
  const publishable = values.CLERK_PUBLISHABLE_KEY ?? values.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (publishable) secrets.CLERK_JWT_ISSUER = deriveClerkIssuer(publishable);
  else console.warn("No CLERK_PUBLISHABLE_KEY in the values file: CLERK_JWT_ISSUER must be supplied by hand");

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote ${outFile} with: ${Object.keys(secrets).join(", ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
