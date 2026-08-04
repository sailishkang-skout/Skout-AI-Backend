import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const TABLES = [
  "sequence_enrollment_steps",
  "sequence_enrollments",
  "sequence_steps",
  "sequences",
  "enrichment_results",
  "enrichment_jobs",
  "enrichment_batches",
  "async_jobs",
  "ai_drafts",
  "prospect_scores",
  "list_members",
  "lists",
  "prospect_activations",
  "smart_list_refreshes",
  "smart_list_members",
  "smart_lists",
  "webhook_deliveries",
  "webhook_endpoints",
  "inbox_messages",
  "inbox_threads",
  "credit_transactions",
  "credit_balances",
  "workspace_icp",
  "workspace_members",
  "users",
  "workspaces",
];

const { db, sql: pgSql } = createDb(resolveDatabaseUrl());

try {
  const tableList = TABLES.map((t) => `"${t}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`));
  console.log(`Truncated ${TABLES.length} tables.`);
} finally {
  await pgSql.end();
}
