/**
 * Live E2E: company-web scrape → clean → docs (no Redis/API required).
 * Usage: node scripts/live-scrape-smoke.mjs [domain]
 */
import { scrapeCompanyWeb } from "../workers/scrapers/orchestrator/dist/bots/company-web.js";
import { cleanCompanies } from "../workers/scrapers/cleaner/dist/company-cleaner.js";
import { recordsToDocs } from "../workers/scrapers/ingestor/dist/index.js";

const domain = process.argv[2] ?? "stripe.com";
const jobId = `smoke-${Date.now()}`;

console.log(`Scraping ${domain}...`);
const raw = await scrapeCompanyWeb(jobId, domain);
const { clean, quarantined } = cleanCompanies([raw]);
const docs = recordsToDocs(clean);

console.log(JSON.stringify({
  domain,
  rawPages: raw.meta?.pages ?? 0,
  cleanCount: clean.length,
  quarantined: quarantined.map((q) => q.reason),
  ingestedDocs: docs.length,
  sample: docs[0]
    ? {
        companyDomain: docs[0].companyDomain,
        companyName: docs[0].companyName,
        employeeCount: docs[0].employeeCount,
        foundedYear: docs[0].foundedYear,
        currentlyHiring: docs[0].currentlyHiring,
        provenanceFields: clean[0]?.provenance?.length,
      }
    : null,
}, null, 2));

if (clean.length === 0 || docs.length === 0) process.exit(1);
