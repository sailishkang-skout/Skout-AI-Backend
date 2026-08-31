#!/usr/bin/env node
/**
 * Verify Microsoft OAuth env is present for Warm-Up Tool without printing secrets.
 * Usage:
 *   node scripts/verify-microsoft-oauth-config.mjs
 *   AWS_REGION=us-east-1 node scripts/verify-microsoft-oauth-config.mjs --from-aws SkoutDev/warmup-tool
 */
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const fromAwsIdx = args.indexOf("--from-aws");
const secretId = fromAwsIdx >= 0 ? args[fromAwsIdx + 1] : null;

function mask(value) {
  if (!value || typeof value !== "string") return "(missing)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

function loadEnv() {
  if (!secretId) {
    return {
      MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
      MICROSOFT_REDIRECT_URI: process.env.MICROSOFT_REDIRECT_URI,
    };
  }
  const raw = execSync(
    `aws secretsmanager get-secret-value --secret-id ${JSON.stringify(secretId)} --query SecretString --output text`,
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(raw);
  return {
    MICROSOFT_CLIENT_ID: parsed.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: parsed.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REDIRECT_URI: parsed.MICROSOFT_REDIRECT_URI,
  };
}

const env = loadEnv();
const checks = [];

function requireField(name, value, predicate, hint) {
  const ok = Boolean(value) && predicate(value);
  checks.push({ name, ok, hint });
}

requireField(
  "MICROSOFT_CLIENT_ID",
  env.MICROSOFT_CLIENT_ID,
  (v) => /^[0-9a-f-]{36}$/i.test(v),
  "Expect a GUID (Application client ID)"
);
requireField(
  "MICROSOFT_CLIENT_SECRET",
  env.MICROSOFT_CLIENT_SECRET,
  (v) => v.length >= 16 && !v.startsWith("replace"),
  "Expect Entra client secret value (not Secret ID)"
);
requireField(
  "MICROSOFT_REDIRECT_URI",
  env.MICROSOFT_REDIRECT_URI,
  (v) => v.includes("/api/v1/warmup-tool/oauth/microsoft/callback"),
  "Must match Skout API public proxy callback"
);

console.log("Microsoft OAuth configuration check (values masked):\n");
for (const c of checks) {
  const value = env[c.name];
  console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${mask(value)}`);
  if (!c.ok) console.log(`  → ${c.hint}`);
}

if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_REDIRECT_URI) {
  const params = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    redirect_uri: env.MICROSOFT_REDIRECT_URI,
    response_type: "code",
    response_mode: "query",
    scope: [
      "openid",
      "email",
      "offline_access",
      "https://graph.microsoft.com/Mail.Send",
      "https://graph.microsoft.com/Mail.Read",
    ].join(" "),
    state: "verify-only",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  });
  const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  console.log("\nAuthorize URL shape (safe to open in browser for consent test):");
  console.log(url);
  console.log(
    "\nAfter consent, Microsoft redirects to MICROSOFT_REDIRECT_URI with ?code=…&state=… — Skout proxies to Warm-Up Tool, which exchanges the code and stores an encrypted refresh token."
  );
}

const failed = checks.some((c) => !c.ok);
process.exit(failed ? 1 : 0);
