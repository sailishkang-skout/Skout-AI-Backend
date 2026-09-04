#!/usr/bin/env node
/**
 * §7.1 / §5 Read-model exceptions (Enterprise Completion Plan) — CI enforcement.
 *
 * ADR 0003 documents apps/api call sites that read apps/crm-owned tables directly out of the
 * shared Postgres instance, each formally justified with an owning-service/reason/review-date
 * comment block ("DOCUMENTED READ-MODEL EXCEPTION"). Before this script, nothing stopped an
 * additional call site from doing the same thing silently — this catches that at PR time.
 *
 * Heuristic, not semantic: it greps the diff for apps/api files that start referencing an
 * apps/crm-owned schema symbol (imported from @skout/db) and weren't already on the allowlist.
 * A file already in KNOWN_EXCEPTION_FILES, or whose current full content already contains the
 * "DOCUMENTED READ-MODEL EXCEPTION" marker, passes silently — this only flags genuinely new,
 * undocumented instances of the pattern.
 *
 * Exit 0 = no new undocumented cross-service table reads. Exit 1 = found at least one.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024 * 32 });
}

function getBaseRef() {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    console.log("Not a pull_request event (no GITHUB_BASE_REF) — skipping read-model-exception check.");
    process.exit(0);
  }
  return base;
}

// apps/crm-owned pgTable symbols (packages/db/src/schema/crm.ts + crm-intelligence.ts), as of
// the last time this list was reconciled against the schema — see ADR 0003 for the source list.
const CRM_OWNED_SYMBOLS = [
  "companies", "contacts", "pipelines", "pipelineStages", "deals", "tasks", "activities",
  "meetings", "meetingAttendees", "calendarConnections",
  "buyingCommittees", "buyingCommitteeMembers", "retentionRules",
];

// Files ADR 0003 already documents as of this script's authoring — kept as a static allowlist
// so edits to these files don't re-trigger the check. New instances outside this list are what
// gets flagged.
const KNOWN_EXCEPTION_FILES = new Set([
  "apps/api/src/routes/ai.routes.ts",
  "apps/api/src/routes/call.routes.ts",
  "apps/api/src/services/cro-summary.service.ts",
  "apps/api/src/services/email-verification.service.ts",
  "apps/api/src/services/enrichment-autofill.service.ts",
  "apps/api/src/services/next-best-action.service.ts",
  "apps/api/src/services/reply-tag-actions.service.ts",
  "apps/api/src/services/tam.service.ts",
  "apps/api/src/services/forecast.service.ts",
  "apps/api/src/services/retention-workflow.service.ts",
  "apps/api/src/workers/reminder-sweep.worker.ts",
  "apps/api/src/workers/sequence-enrollment.worker.ts",
]);

const EXCEPTION_MARKER = "DOCUMENTED READ-MODEL EXCEPTION";
const symbolRe = new RegExp(`\\b(${CRM_OWNED_SYMBOLS.join("|")})\\b`);

function changedApiFiles(baseRef) {
  sh(`git fetch --no-tags --depth=50 origin ${baseRef}`);
  const out = sh(`git diff --name-only origin/${baseRef}...HEAD -- apps/api/src/`);
  return out.split("\n").map((l) => l.trim()).filter(Boolean).filter((f) => f.endsWith(".ts"));
}

function addedLinesFor(baseRef, file) {
  const diff = sh(`git diff origin/${baseRef}...HEAD -- "${file}"`);
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

const baseRef = getBaseRef();
const files = changedApiFiles(baseRef);
const flagged = [];

for (const file of files) {
  if (KNOWN_EXCEPTION_FILES.has(file)) continue;
  if (!existsSync(file)) continue; // deleted file

  const added = addedLinesFor(baseRef, file);
  const referencesOwnedSymbol = added.some(
    (line) => symbolRe.test(line) && (line.includes("schema.") || line.includes("@skout/db") || /=\s*schema/.test(line))
  );
  if (!referencesOwnedSymbol) continue;

  const fullContent = readFileSync(file, "utf8");
  if (fullContent.includes(EXCEPTION_MARKER)) continue; // documented in this same PR — OK

  flagged.push(file);
}

if (flagged.length === 0) {
  console.log("No new undocumented cross-service (apps/crm-owned) table reads found in apps/api. OK.");
  process.exit(0);
}

console.error(
  [
    "§7.1 Read-model exception check FAILED.",
    "",
    "These changed files appear to read an apps/crm-owned table directly, without a",
    `"${EXCEPTION_MARKER}" comment block and without being on the existing ADR 0003 allowlist:`,
    "",
    ...flagged.map((f) => `  - ${f}`),
    "",
    "Either replace the direct table read with a real call through apps/crm's API, or add a",
    "formal exception comment matching ADR 0003's template (tables read, owning service,",
    "reason, review date) and get it reviewed — see docs/adr/0003-read-model-exceptions.md.",
    "",
    "(This is a heuristic grep-based check, not a semantic one — if it flagged a false",
    "positive, add the exception comment anyway or ping the architecture reviewer to adjust",
    "this script's allowlist.)",
  ].join("\n")
);
process.exit(1);
