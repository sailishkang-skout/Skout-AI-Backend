#!/usr/bin/env node
/**
 * Company-web seed smoke (R6.3) — enqueues domains from data/seeds/company-web-100.json.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 node scripts/corpus-seed-smoke.mjs
 *   CORPUS_SEED_LIMIT=5 node scripts/corpus-seed-smoke.mjs
 *   VERIFY_SEARCH=1 API_URL=http://localhost:3001 STUB_EMAIL=extension@example.com node scripts/corpus-seed-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { enqueueScrapeJob } from "../workers/scrapers/orchestrator/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, "../data/seeds/company-web-100.json");
const payload = JSON.parse(readFileSync(seedPath, "utf8"));
const seeds = (payload.domains ?? payload).map(String);
const limit = Number(process.env.CORPUS_SEED_LIMIT ?? seeds.length);
const batch = seeds.slice(0, limit);

const manifest = await enqueueScrapeJob({ source: "company-web", seeds: batch });
console.log(`✓ Enqueued company-web seed batch (${batch.length} domains)`, manifest.jobId);

if (process.env.VERIFY_SEARCH === "1") {
  const apiUrl = (process.env.API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const stubEmail = process.env.STUB_EMAIL ?? "extension@example.com";
  const domain = batch[0];
  const res = await fetch(`${apiUrl}/api/v1/search/prospects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-stub-user-email": stubEmail,
    },
    body: JSON.stringify({
      query: domain.split(".")[0],
      page: 1,
      pageSize: 5,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn(`⚠ Search verify returned ${res.status}:`, body.error ?? body);
  } else {
    console.log(
      `✓ Search verify: total=${body.total ?? 0} source=${body.source ?? "unknown"} (run workers + wait for ingest)`
    );
  }
}
