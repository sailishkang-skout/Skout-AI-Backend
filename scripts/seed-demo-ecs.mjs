#!/usr/bin/env node
/**
 * Minimal demo workspace seed for ECS one-off tasks (no dotenv/drizzle deps beyond postgres).
 * Usage: node scripts/seed-demo-ecs.mjs
 */
import postgres from "postgres";

const ws = "00000000-0000-4000-8000-000000000001";
const sql = postgres({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME ?? "skout",
  user: process.env.DATABASE_USER ?? "skout",
  password: process.env.DATABASE_PASSWORD,
  ssl: "require",
});

try {
  await sql`
    insert into workspaces (id, name, slug)
    values (${ws}::uuid, ${"Demo Workspace"}, ${"demo"})
    on conflict (id) do nothing
  `;
  await sql`
    insert into credit_balances (workspace_id, balance)
    values (${ws}::uuid, 500)
    on conflict (workspace_id) do update set balance = 500, updated_at = now()
  `;
  console.log("Demo workspace seeded (500 credits)");
} finally {
  await sql.end();
}
