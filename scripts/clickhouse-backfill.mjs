#!/usr/bin/env node
/** Backfill credit_transactions into ClickHouse skout_events (R7.1). */
import pg from "pg";
import { insertAnalyticsEvent } from "../apps/api/dist/lib/clickhouse.js";
import { loadEnv } from "../apps/api/dist/config/env.js";

const config = loadEnv();
if (!config.CLICKHOUSE_URL) {
  console.error("CLICKHOUSE_URL required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(
  `SELECT workspace_id, amount, action, reference_id, created_at
   FROM credit_transactions
   ORDER BY created_at ASC
   LIMIT 50000`
);

let count = 0;
for (const row of rows) {
  await insertAnalyticsEvent(config, {
    workspaceId: row.workspace_id,
    eventType: row.amount < 0 ? "credit_spend" : "credit_add",
    amount: row.amount,
    referenceId: row.reference_id ?? "",
    metadata: { action: row.action, backfill: true },
  });
  count += 1;
}

await pool.end();
console.log(`Backfilled ${count} credit events to ClickHouse`);
