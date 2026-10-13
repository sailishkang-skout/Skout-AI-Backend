#!/usr/bin/env node
/**
 * Migration validation (ENR-06) — CI enforcement for packages/db/drizzle.
 *
 * The migration runner applies whatever _journal.json lists, in order. A journal that is valid
 * JSON can still be wrong in ways git merges produce silently: two migrations sharing one
 * entry (a duplicated "tag" key — the second wins and the first never runs), two entries with
 * the same timestamp, or a .sql file with no entry at all. Each of those ships a schema that
 * is missing a table, and nothing fails until a query does.
 *
 * Always checked:
 *   - no entry has a duplicated key; idx values are unique and increasing
 *   - `when` values are unique and increasing (the runner records applied migrations by `when`)
 *   - every entry has its .sql file and every .sql file has an entry
 * On a pull request (GITHUB_BASE_REF set), for migrations the PR adds:
 *   - they are appended after every migration already on the base branch
 *   - they are additive, or say why not in a `-- migration-safety:` comment
 *
 * Exit 0 = valid. Exit 1 = problems, each printed with the file it concerns.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "packages/db/drizzle";
const JOURNAL = join(DIR, "meta", "_journal.json");

/** Predates this check; applied by packages/db/src/apply-pending.ts rather than the journal. */
const LEGACY_UNJOURNALED = new Set(["0001_add_clerk_user_id", "0002_add_user_access_flags", "0027_unipile_channels", "0047_warmup_tool_sync_state", "0096_add_scim_api_token"]);
/** Two old entries share this timestamp. Both are long applied everywhere; changing either would re-run it. */
const LEGACY_DUPLICATE_WHEN = new Set([1793200000000]);
/** Old entries whose timestamp is earlier than the entry before them. Long applied; left as they are. */
const LEGACY_OUT_OF_ORDER = new Set(["0014_domain_warmup_blacklist", "0080_whatsapp_outreach_jobs_pending_idx"]);

const problems = [];
const fail = (message) => problems.push(message);

const raw = readFileSync(JOURNAL, "utf8");
let journal;
try {
  journal = JSON.parse(raw);
} catch (error) {
  console.error(`${JOURNAL} is not valid JSON: ${error.message}`);
  process.exit(1);
}
const entries = journal.entries ?? [];

// JSON.parse keeps the last of two identical keys, so duplicates are found in the text.
for (const block of raw.match(/\{[^{}]*\}/g) ?? []) {
  for (const key of ["idx", "when", "tag", "version", "breakpoints"]) {
    const count = (block.match(new RegExp(`"${key}"\\s*:`, "g")) ?? []).length;
    if (count > 1) {
      const tags = [...block.matchAll(/"tag"\s*:\s*"([^"]+)"/g)].map((match) => match[1]).join(", ");
      fail(`${JOURNAL}: an entry has "${key}" ${count} times (${tags}). Each migration needs its own entry.`);
    }
  }
}

const seenIdx = new Set();
const seenWhen = new Map();
let previous = null;
for (const entry of entries) {
  if (seenIdx.has(entry.idx)) fail(`${JOURNAL}: idx ${entry.idx} is used twice (${entry.tag}).`);
  seenIdx.add(entry.idx);
  if (seenWhen.has(entry.when) && !LEGACY_DUPLICATE_WHEN.has(entry.when)) {
    fail(`${JOURNAL}: ${entry.tag} has the same "when" as ${seenWhen.get(entry.when)}. The runner would treat one of them as already applied.`);
  }
  seenWhen.set(entry.when, entry.tag);
  if (previous && entry.idx <= previous.idx) fail(`${JOURNAL}: ${entry.tag} (idx ${entry.idx}) is not after ${previous.tag} (idx ${previous.idx}).`);
  if (previous && entry.when < previous.when && !LEGACY_OUT_OF_ORDER.has(entry.tag)) fail(`${JOURNAL}: ${entry.tag} has an earlier "when" than ${previous.tag}, which precedes it.`);
  previous = entry;
}

const files = new Set(readdirSync(DIR).filter((name) => name.endsWith(".sql")).map((name) => name.slice(0, -4)));
const tags = new Set(entries.map((entry) => entry.tag));
for (const tag of tags) if (!files.has(tag)) fail(`${JOURNAL}: ${tag} has no ${DIR}/${tag}.sql.`);
for (const file of files) if (!tags.has(file) && !LEGACY_UNJOURNALED.has(file)) fail(`${DIR}/${file}.sql has no journal entry, so it would never be applied.`);

// ── New migrations on a pull request ─────────────────────────────────────────

const DESTRUCTIVE = [
  [/\bDROP\s+TABLE\b/i, "drops a table"],
  [/\bDROP\s+COLUMN\b/i, "drops a column"],
  [/\bRENAME\s+(COLUMN|TO)\b/i, "renames a table or column"],
  [/\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i, "changes a column type"],
  [/\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i, "adds NOT NULL to an existing column"],
  [/\bTRUNCATE\b/i, "truncates a table"],
  [/\bDELETE\s+FROM\b/i, "deletes rows"],
];

const base = process.env.GITHUB_BASE_REF;
if (base) {
  let baseEntries = [];
  try {
    execSync(`git fetch origin ${base} --depth=1`, { stdio: "ignore" });
    baseEntries = JSON.parse(execSync(`git show origin/${base}:${JOURNAL}`, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 })).entries ?? [];
  } catch {
    console.log(`Could not read ${JOURNAL} on ${base}; skipping the new-migration checks.`);
  }
  if (baseEntries.length) {
    const baseTags = new Set(baseEntries.map((entry) => entry.tag));
    const lastWhen = Math.max(...baseEntries.map((entry) => entry.when));
    const lastIdx = Math.max(...baseEntries.map((entry) => entry.idx));
    for (const entry of baseEntries) {
      if (!tags.has(entry.tag)) fail(`${JOURNAL}: ${entry.tag} exists on ${base} but not here. A migration that may already be applied must not be removed or renamed.`);
    }
    for (const entry of entries.filter((candidate) => !baseTags.has(candidate.tag))) {
      if (entry.when <= lastWhen || entry.idx <= lastIdx) {
        fail(`${JOURNAL}: new migration ${entry.tag} is not after the last migration on ${base}. Databases that already ran those would skip it — renumber it to the end.`);
      }
      if (!files.has(entry.tag)) continue;
      const sql = readFileSync(join(DIR, `${entry.tag}.sql`), "utf8");
      if (/--\s*migration-safety:\s*\S+/i.test(sql)) continue;
      const statements = sql.replace(/--.*$/gm, "");
      for (const [pattern, what] of DESTRUCTIVE) {
        if (pattern.test(statements)) {
          fail(`${DIR}/${entry.tag}.sql ${what}. Migrations must be additive; if this one is safe, add a "-- migration-safety: <why>" comment.`);
        }
      }
    }
  }
}

if (problems.length) {
  console.error("Migration validation FAILED.\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Migration validation OK: ${entries.length} journal entries, ${files.size} SQL files.`);
