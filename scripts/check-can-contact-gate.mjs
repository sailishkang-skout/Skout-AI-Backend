#!/usr/bin/env node
/**
 * COPS-07 (Bible p.86): consent and suppression are enforced through the single canContact() gate
 * (apps/api/src/services/cops-can-contact.ts). This check fails when code calls the pieces behind
 * the gate directly: isSuppressed(), isSendBlockedByEligibility() or gateEnrollConsent().
 *
 * It is a ratchet. BASELINE lists the files that called them before the gate existed, with the
 * number of calls each may still have. A new file, or more calls in a listed file, fails. When a
 * listed file is moved onto canContact(), lower or remove its entry.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOTS = ["apps/api/src", "apps/crm/src"];
const PATTERN = /\b(isSuppressed|isSendBlockedByEligibility|gateEnrollConsent)\s*\(/g;

/** The gate itself and the three definitions. */
const ALLOWED = new Set([
  "apps/api/src/services/cops-can-contact.ts",
  "apps/api/src/services/suppression.service.ts",
  "apps/api/src/services/send-eligibility-guard.service.ts",
  "apps/api/src/services/consent-enroll.service.ts",
]);

/** Direct callers that predate the gate (2026-10-09). Do not add to this list; migrate instead. */
const BASELINE = {
  "apps/api/src/routes/ai.routes.ts": 1,
  "apps/api/src/routes/compliance.routes.ts": 1,
  "apps/api/src/routes/sequence.routes.ts": 2,
  "apps/api/src/services/ai-draft-send.service.ts": 2,
  "apps/api/src/services/inbox.service.ts": 1,
  "apps/api/src/services/reply-tag-actions.service.ts": 1,
  "apps/api/src/workers/sequence-enrollment.worker.ts": 5,
};

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const failures = [];
const seen = new Set();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative(process.cwd(), file).split(sep).join("/");
    if (ALLOWED.has(rel)) continue;
    const count = (readFileSync(file, "utf8").match(PATTERN) ?? []).length;
    if (count === 0) continue;
    seen.add(rel);
    const allowed = BASELINE[rel] ?? 0;
    if (count > allowed) {
      failures.push(
        allowed === 0
          ? `${rel}: ${count} direct call(s) to a consent/suppression check. Use canContact() from services/cops-can-contact.ts.`
          : `${rel}: ${count} direct call(s), baseline allows ${allowed}. New sends must go through canContact().`
      );
    }
  }
}

if (failures.length > 0) {
  console.error("canContact() gate check failed:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
const stale = Object.keys(BASELINE).filter((f) => !seen.has(f));
if (stale.length > 0) console.log("Baseline entries with no direct calls left (remove them): " + stale.join(", "));
console.log("canContact() gate: no new direct consent/suppression checks. OK.");
