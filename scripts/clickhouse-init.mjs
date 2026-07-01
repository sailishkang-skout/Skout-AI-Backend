#!/usr/bin/env node
/** Apply ClickHouse analytics schema (R7.1). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function parseUrl(url) {
  const u = new URL(url);
  return {
    base: `${u.protocol}//${u.host}`,
    database: u.pathname.replace(/^\//, "") || "default",
    user: u.username,
    password: u.password,
  };
}

async function runQuery(base, auth, query) {
  const res = await fetch(`${base}/?query=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickHouse init failed (${res.status}): ${text}`);
  }
}

const rawUrl = process.env.CLICKHOUSE_URL ?? "http://localhost:8123/skout";
const { base, user, password } = parseUrl(rawUrl);
const auth = user && password ? `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` : undefined;

const sqlPath = join(dirname(fileURLToPath(import.meta.url)), "clickhouse-init.sql");
const statements = readFileSync(sqlPath, "utf8")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

for (const statement of statements) {
  await runQuery(base, auth, statement);
  console.log("✓", statement.split("\n")[0]);
}

await runQuery(base, auth, "SELECT count() FROM skout.skout_events");
const check = await fetch(`${base}/?query=${encodeURIComponent("SELECT count() FROM skout.skout_events")}`, {
  headers: auth ? { Authorization: auth } : {},
});
const body = await check.text();
console.log("skout.skout_events rows:", body.trim());
