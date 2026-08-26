#!/usr/bin/env node
/**
 * §1 Architecture gate (Enterprise Completion Plan) — CI enforcement.
 *
 * The PR template asks: "Does this feature read/write the canonical entities... or does it
 * create its own local copy of state?" — but until now that was pure reviewer discipline;
 * nothing technically stopped a PR from adding a new table and shipping without anyone
 * answering the question. This script closes that gap for the one case that's cheaply and
 * reliably detectable from a diff: a brand-new `pgTable(...)` definition.
 *
 * It is a heuristic (grep-based diff scan), not a semantic analysis — it can't tell whether a
 * new table genuinely duplicates canonical state or not, only that a new table exists and the
 * PR description didn't answer the question. That's the actual gap named in the audit ("no
 * automated enforcement exists"); this makes the review question mandatory to answer, not
 * mandatory to answer *correctly* — that part still needs the named architecture reviewer.
 *
 * Exit 0 = no new tables, or the gate question is answered. Exit 1 = new table(s) found and
 * the PR body doesn't show an answered §1 gate line.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024 * 32 });
}

function getBaseRef() {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    console.log("Not a pull_request event (no GITHUB_BASE_REF) — skipping architecture-gate check.");
    process.exit(0);
  }
  return base;
}

function getPrBody() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return "";
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return event.pull_request?.body ?? "";
  } catch {
    return "";
  }
}

function findNewTables(baseRef) {
  sh(`git fetch --no-tags --depth=50 origin ${baseRef}`);
  const diff = sh(`git diff origin/${baseRef}...HEAD -- packages/db/src/schema/`);
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));

  const tableNames = [];
  const tableRe = /export const (\w+)\s*=\s*pgTable\(/;
  for (const line of added) {
    const m = line.match(tableRe);
    if (m) tableNames.push(m[1]);
  }
  return tableNames;
}

/**
 * The PR template's §1 line looks like:
 *   - [ ] **Does this feature read/write the canonical entities** ... : _______
 * "Answered" means: checked ([x], any case) AND the trailing blank has real content, not just
 * underscores/whitespace.
 */
function gateAnswered(prBody) {
  const gateLineRe = /-\s*\[([ xX])\]\s*\*\*Does this feature read\/write the canonical entities\*\*.*?:\s*(.*)$/m;
  const m = prBody.match(gateLineRe);
  if (!m) return false;
  const checked = m[1].toLowerCase() === "x";
  const answer = (m[2] || "").replace(/_/g, "").trim();
  return checked && answer.length > 0;
}

const baseRef = getBaseRef();
const newTables = findNewTables(baseRef);

if (newTables.length === 0) {
  console.log("No new pgTable() definitions in this PR — architecture gate not triggered.");
  process.exit(0);
}

const prBody = getPrBody();
if (gateAnswered(prBody)) {
  console.log(`New table(s) found (${newTables.join(", ")}) and the §1 architecture gate is answered in the PR description. OK.`);
  process.exit(0);
}

console.error(
  [
    "§1 Architecture gate check FAILED.",
    "",
    `This PR adds new table(s): ${newTables.join(", ")}`,
    "",
    "The PR template's §1 Architecture gate line must be checked AND answered:",
    '  - [x] **Does this feature read/write the canonical entities** ... : <your answer, not blank>',
    "",
    "If this table forks state that Evidence Ledger / Tenancy / identity already models, name",
    "the reviewer who signed off on that in the same line. If it's genuinely new canonical",
    "state, say so — the point is that someone has to answer, not that the answer is always no.",
  ].join("\n")
);
process.exit(1);
