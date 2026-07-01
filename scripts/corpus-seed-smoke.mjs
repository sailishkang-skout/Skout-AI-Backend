#!/usr/bin/env node
/**
 * Company-web seed smoke (R6.3) — enqueues all domains from data/seeds/company-web-100.json.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 node scripts/corpus-seed-smoke.mjs
 *   CORPUS_SEED_LIMIT=5 node scripts/corpus-seed-smoke.mjs
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
