/**
 * ClickHouse analytics events (R7.1).
 *
 * Schema (run once on your ClickHouse instance):
 *
 * CREATE TABLE IF NOT EXISTS skout_events (
 *   workspace_id String,
 *   event_type LowCardinality(String),
 *   event_time DateTime64(3, 'UTC'),
 *   amount Int32 DEFAULT 0,
 *   reference_id String DEFAULT '',
 *   metadata String DEFAULT '{}'
 * ) ENGINE = MergeTree()
 * ORDER BY (workspace_id, event_type, event_time);
 */
import type { Env } from "../config/env.js";
import { createLogger } from "@skout/observability";

const log = createLogger("clickhouse");

export function isClickHouseEnabled(config: Env): boolean {
  const url = config.CLICKHOUSE_URL?.trim();
  return Boolean(url && url !== "replace-me" && !url.includes("REPLACE_WITH"));
}

function authHeader(user?: string, password?: string): string | undefined {
  return user && password ? `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` : undefined;
}

async function runClickHouseQuery(
  config: Env,
  query: string,
  opts?: { timeoutMs?: number }
): Promise<boolean> {
  if (!isClickHouseEnabled(config)) return false;

  const { base, user, password } = parseUrl(config.CLICKHOUSE_URL!);
  const auth = authHeader(user, password);

  try {
    const res = await fetch(`${base}/?query=${encodeURIComponent(query)}`, {
      method: "POST",
      headers: auth ? { Authorization: auth } : {},
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn("ClickHouse query failed", { status: res.status, text: text.slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("ClickHouse query error", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Ensure analytics tables exist (idempotent — safe on API startup). */
export async function ensureClickHouseSchema(config: Env): Promise<void> {
  if (!isClickHouseEnabled(config)) return;

  const { database } = parseUrl(config.CLICKHOUSE_URL!);
  const db = database || "skout";

  const statements = [
    `CREATE DATABASE IF NOT EXISTS ${db}`,
    `CREATE TABLE IF NOT EXISTS ${db}.skout_events (
      workspace_id String,
      event_type LowCardinality(String),
      event_time DateTime64(3, 'UTC'),
      amount Int32 DEFAULT 0,
      reference_id String DEFAULT '',
      metadata String DEFAULT '{}'
    ) ENGINE = MergeTree()
    ORDER BY (workspace_id, event_type, event_time)`,
  ];

  for (const statement of statements) {
    const ok = await runClickHouseQuery(config, statement, { timeoutMs: 15_000 });
    if (!ok) {
      log.warn("ClickHouse schema bootstrap incomplete");
      return;
    }
  }

  log.info("ClickHouse schema ready", { database: db });
}

function parseUrl(url: string) {
  const u = new URL(url);
  return {
    base: `${u.protocol}//${u.host}`,
    database: u.pathname.replace(/^\//, "") || "default",
    user: u.username,
    password: u.password,
  };
}

export async function insertAnalyticsEvent(
  config: Env,
  event: {
    workspaceId: string;
    eventType: string;
    amount?: number;
    referenceId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  if (!isClickHouseEnabled(config)) return;

  const { base, database, user, password } = parseUrl(config.CLICKHOUSE_URL!);
  const row = {
    workspace_id: event.workspaceId,
    event_type: event.eventType,
    event_time: new Date().toISOString().replace("T", " ").replace("Z", ""),
    amount: event.amount ?? 0,
    reference_id: event.referenceId ?? "",
    metadata: JSON.stringify(event.metadata ?? {}),
  };

  const query = `INSERT INTO ${database}.skout_events FORMAT JSONEachRow`;
  const auth = authHeader(user, password);

  try {
    const res = await fetch(`${base}/?query=${encodeURIComponent(query)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
      },
      body: `${JSON.stringify(row)}\n`,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn("ClickHouse insert failed", { status: res.status, text: text.slice(0, 200) });
    }
  } catch (err) {
    log.warn("ClickHouse insert error", { err: err instanceof Error ? err.message : String(err) });
  }
}

export async function queryDailyCreditTotals(
  config: Env,
  workspaceId: string,
  sinceIso: string
): Promise<Array<{ date: string; spent: number; added: number }> | null> {
  if (!isClickHouseEnabled(config)) return null;

  const { base, database, user, password } = parseUrl(config.CLICKHOUSE_URL!);
  const since = sinceIso.slice(0, 19).replace("T", " ");
  const sql = `
    SELECT
      toDate(event_time) AS date,
      sumIf(abs(amount), amount < 0) AS spent,
      sumIf(amount, amount > 0) AS added
    FROM ${database}.skout_events
    WHERE workspace_id = {ws:String}
      AND event_type IN ('credit_spend', 'credit_add')
      AND event_time >= {since:DateTime64}
    GROUP BY date
    ORDER BY date
  `;

  const params = new URLSearchParams({
    query: sql,
    param_ws: workspaceId,
    param_since: since,
    default_format: "JSON",
  });

  const auth = authHeader(user, password);

  try {
    const res = await fetch(`${base}/?${params}`, {
      headers: auth ? { Authorization: auth } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ date: string; spent: string; added: string }> };
    return (body.data ?? []).map((r) => ({
      date: String(r.date).slice(0, 10),
      spent: Number(r.spent) || 0,
      added: Number(r.added) || 0,
    }));
  } catch {
    return null;
  }
}
