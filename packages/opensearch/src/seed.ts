import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildDemoCorpus } from "./demo-corpus.js";
import { bulkUpsertProspects, ensureProspectsIndex, type OpenSearchConfig } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const url = process.env.OPENSEARCH_URL;
if (!url) {
  console.error("OPENSEARCH_URL is required (e.g. http://localhost:9200)");
  process.exit(1);
}

const cfg: OpenSearchConfig = {
  url,
  username: process.env.OPENSEARCH_USERNAME || undefined,
  password: process.env.OPENSEARCH_PASSWORD || undefined,
  index: process.env.OPENSEARCH_INDEX ?? "prospects",
};

const count = Number(process.env.DEMO_CORPUS_SIZE ?? 5300);

try {
  console.log(`Ensuring index "${cfg.index ?? "prospects"}"…`);
  await ensureProspectsIndex(cfg);
  const docs = buildDemoCorpus(count);
  console.log(`Upserting ${docs.length} demo prospects…`);
  const { ingested, failed } = await bulkUpsertProspects(cfg, docs);
  console.log(`Done — ingested ${ingested}, failed ${failed}`);
} catch (err) {
  console.error("Seed failed:", err);
  process.exit(1);
}
