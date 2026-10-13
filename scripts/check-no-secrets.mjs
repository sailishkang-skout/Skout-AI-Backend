#!/usr/bin/env node
/**
 * Secret and data-leak scan (ENR-06). Fails when a tracked file looks like something that must
 * never be committed: an environment file, a database dump or export, captured customer data,
 * or a credential pasted into source.
 *
 * It reads `git ls-files`, so it sees exactly what a clone would contain. It is a tripwire for
 * the common accidents, not a replacement for a secret-scanning service.
 */
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const tracked = execSync("git ls-files", { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }).split("\n").filter(Boolean);

const FORBIDDEN_FILES = [
  // `.env`, `.env.local`, `.env.prod` — but not the `*.example` templates, which hold no values.
  [/(^|\/)\.env(\.[\w-]+)*$/, "environment file", /\.(example|sample|template)$/],
  [/\.(dump|pgdump|sql\.gz|bak)$/i, "database dump"],
  [/(^|\/)(pg_dump|db[-_]export|database[-_]export)[^/]*$/i, "database export"],
  [/\.(pem|p12|pfx|key)$/i, "private key file"],
  [/(^|\/)captured[-_]?(profiles|leads|people|data)[^/]*\.(json|csv)$/i, "captured LinkedIn data"],
];

const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bsk_live_[0-9a-zA-Z]{24,}\b/, "Stripe live secret key"],
  [/\bxox[baprs]-[0-9A-Za-z-]{20,}\b/, "Slack token"],
  [/\bgh[pousr]_[0-9A-Za-z]{36,}\b/, "GitHub token"],
  [/\bsk-ant-[0-9A-Za-z_-]{20,}\b/, "Anthropic API key"],
  [/\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{20,}\b/, "Resend API key"],
  [/postgres(ql)?:\/\/[^:\s"']+:[^@\s"']{8,}@(?!localhost|127\.0\.0\.1|postgres|db|host\.docker\.internal)[^\s"'/]+\.(rds\.amazonaws\.com|supabase\.co|neon\.tech)/i, "hosted database URL with a password"],
];

const SKIP_CONTENT = /\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|woff2?|ttf|mp4|lock)$|(^|\/)(pnpm-lock\.yaml|package-lock\.json)$|^scripts\/check-no-secrets\.mjs$|\.test\.(m?[jt]sx?)$/i;
const MAX_BYTES = 1_000_000;

const findings = [];
for (const file of tracked) {
  for (const [pattern, what, except] of FORBIDDEN_FILES) {
    if (pattern.test(file) && !except?.test(file)) findings.push(`${file}: ${what} must not be committed`);
  }
  if (SKIP_CONTENT.test(file)) continue;
  let text;
  try {
    if (statSync(file).size > MAX_BYTES) continue;
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (const [pattern, what] of SECRET_PATTERNS) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) findings.push(`${file}:${index + 1}: looks like a ${what}`);
  }
}

if (findings.length) {
  console.error("Secret scan FAILED. Remove these from the repository and rotate anything real:\n");
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log(`Secret scan OK: ${tracked.length} tracked files checked.`);
