/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-14 addition).
 *   - Tables touched directly: companies (read only: id, workspace_id, health_score, deleted_at)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: benchmarks compare an account's health with its workspace peers in one query.
 *   - Review date: 2026-11-03
 */
import { sql } from "drizzle-orm";
import type { Db } from "@skout/db";

/**
 * COPS-14 cross-account intelligence: how one account compares with the other accounts in the same
 * workspace. Tenant privacy is strict: peers come only from this workspace, never another tenant,
 * and nothing is shown unless at least MIN_PEERS other accounts have the same measure, so no single
 * peer's value can be read back from a median or a rank.
 */
export const MIN_PEERS = 5;

export interface Benchmark {
  key: string;
  label: string;
  value: number | null;
  peer_median: number | null;
  peers: number;
  /** Share of peers this account does better than (0-100); null when hidden. */
  better_than_pct: number | null;
  /** Higher is better for this measure. */
  higher_is_better: boolean;
}

/** Pure: compares a value with its peers (the account itself excluded), hidden below MIN_PEERS. */
export function compare(key: string, label: string, value: number | null, peerValues: number[], higherIsBetter: boolean): Benchmark {
  const peers = peerValues.filter((v) => Number.isFinite(v));
  if (value === null || peers.length < MIN_PEERS) return { key, label, value, peer_median: null, peers: peers.length, better_than_pct: null, higher_is_better: higherIsBetter };
  const sorted = [...peers].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const beaten = peers.filter((p) => (higherIsBetter ? value > p : value < p)).length;
  return { key, label, value, peer_median: Math.round(median * 10) / 10, peers: peers.length, better_than_pct: Math.round((beaten / peers.length) * 100), higher_is_better: higherIsBetter };
}

type Row = { account_id: string; health: number | null; days_to_activate: number | null; open_tickets: number };

export async function accountBenchmarks(db: Db, workspaceId: string, accountId: string): Promise<{ min_peers: number; benchmarks: Benchmark[] }> {
  const res = await db.execute(sql`
    select c.id::text as account_id,
           c.health_score as health,
           (select extract(epoch from (oi.activated_at - oi.created_at)) / 86400
              from cops_onboarding_instances oi
             where oi.workspace_id = c.workspace_id and oi.account_id = c.id and oi.activated_at is not null
             order by oi.activated_at desc limit 1) as days_to_activate,
           (select count(*)::int from engineering_tickets t
             where t.workspace_id = c.workspace_id and t.account_id = c.id and t.status not in ('resolved','verified','closed')) as open_tickets
      from companies c
     where c.workspace_id = ${workspaceId} and c.deleted_at is null`);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Row[];
  const me = rows.find((r) => r.account_id === accountId);
  if (!me) return { min_peers: MIN_PEERS, benchmarks: [] };
  const others = rows.filter((r) => r.account_id !== accountId);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const peerOf = (pick: (r: Row) => number | null) => others.map(pick).filter((v): v is number => v !== null);
  return {
    min_peers: MIN_PEERS,
    benchmarks: [
      compare("health", "Health score", num(me.health), peerOf((r) => num(r.health)), true),
      compare("days_to_activate", "Days from start to activation", num(me.days_to_activate) === null ? null : Math.round(num(me.days_to_activate)! * 10) / 10, peerOf((r) => num(r.days_to_activate)), false),
      // Only accounts that have been scored count as peers here, so idle prospects do not flatter it.
      compare("open_tickets", "Open engineering tickets", num(me.open_tickets), others.filter((r) => r.health !== null).map((r) => Number(r.open_tickets)), false),
    ],
  };
}
