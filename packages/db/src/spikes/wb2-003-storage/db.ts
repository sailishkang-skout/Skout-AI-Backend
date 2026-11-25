import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { type Variant, schemaOf, tables } from "./variants.js";

export type Sql = ReturnType<typeof postgres>;

export const DEFAULT_URL = "postgresql://postgres:spike@localhost:55432/skout_spike";

/**
 * The spike creates and drops whole schemas, so it refuses to run against anything that is not an
 * obviously local database with "spike" in its name.
 */
export function assertSafeDatabaseUrl(url: string): void {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!local || !/spike/i.test(name)) {
    throw new Error(`Refusing to run the WB2-003 storage spike against "${u.hostname}/${name}": the host must be local and the database name must contain "spike".`);
  }
}

export function connect(max = 4): Sql {
  const url = process.env.WB_SPIKE_DATABASE_URL ?? DEFAULT_URL;
  assertSafeDatabaseUrl(url);
  return postgres(url, { max, onnotice: () => {}, idle_timeout: 30, connect_timeout: 15 });
}

/** Same derivation as the SQL `md5('wb2003:<tag>:<kind>:<n>')::uuid`, so JS and SQL agree on ids. */
export function idOf(tag: string, kind: string, n: string | number): string {
  const h = createHash("md5").update(`wb2003:${tag}:${kind}:${n}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const workbookIdOf = (tag: string) => idOf(tag, "wb", "0");
export const columnIdOf = (tag: string, index: number) => idOf(tag, "col", index);

export interface Tenants {
  workspaceA: string;
  workspaceB: string;
  userA: string;
}

/** Two real workspaces and a user, created through plain inserts into the project's own tables. */
export async function ensureTenants(sql: Sql): Promise<Tenants> {
  const ws = async (slug: string, name: string) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO public.workspaces (name, slug) VALUES (${name}, ${slug})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    return row!.id;
  };
  const workspaceA = await ws("wb2003-spike-a", "WB2-003 spike workspace A");
  const workspaceB = await ws("wb2003-spike-b", "WB2-003 spike workspace B");
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO public.users (email) VALUES ('wb2003-spike@example.invalid')
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`;
  return { workspaceA, workspaceB, userA: u!.id };
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** <repo>/docs/spikes/wb2-003-storage/results */
export const DEFAULT_RESULTS_DIR = path.resolve(here, "../../../../../docs/spikes/wb2-003-storage/results");
/** Tests point this at a temp directory so they never overwrite the recorded benchmark results. */
export const resultsDir = () => process.env.WB_SPIKE_RESULTS_DIR ?? DEFAULT_RESULTS_DIR;

export function saveResult(name: string, data: unknown): string {
  mkdirSync(resultsDir(), { recursive: true });
  const file = path.join(resultsDir(), `${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

export function saveText(name: string, text: string): string {
  mkdirSync(resultsDir(), { recursive: true });
  const file = path.join(resultsDir(), name);
  writeFileSync(file, text);
  return file;
}

export interface TableSizes {
  heapBytes: number;
  indexBytes: number;
  totalBytes: number;
  partitions: number;
  /** Whole-table row estimate from the catalog. */
  estimatedRows: number;
}

/** Heap and index size of workbook_cells, summed over its partitions when it has them. */
export async function cellSizes(sql: Sql, v: Variant): Promise<TableSizes> {
  const cells = tables(v).cells;
  // pg_partition_tree returns nothing for a plain (unpartitioned) table.
  const leaves =
    v.partition === "none"
      ? `SELECT '${cells}'::regclass AS relid`
      : `SELECT relid FROM pg_partition_tree('${cells}'::regclass) WHERE isleaf`;
  const [r] = await sql.unsafe<{ heap: string; idx: string; parts: number; est: string }[]>(`
    SELECT coalesce(sum(pg_relation_size(relid)), 0)::text AS heap,
           coalesce(sum(pg_indexes_size(relid)), 0)::text AS idx,
           count(*)::int AS parts,
           coalesce(sum((SELECT reltuples FROM pg_class WHERE oid = relid)), 0)::bigint::text AS est
    FROM (${leaves}) l`);
  const heapBytes = Number(r!.heap);
  const indexBytes = Number(r!.idx);
  return { heapBytes, indexBytes, totalBytes: heapBytes + indexBytes, partitions: r!.parts, estimatedRows: Number(r!.est) };
}

export const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

export async function vacuumAnalyze(sql: Sql, v: Variant): Promise<number> {
  const t0 = performance.now();
  for (const tbl of [tables(v).workbooks, tables(v).columns, tables(v).rows, tables(v).cells]) {
    await sql.unsafe(`VACUUM (ANALYZE) ${tbl}`);
  }
  return performance.now() - t0;
}

export { schemaOf, tables };

/**
 * Quiet the database before a measurement: checkpoint, then wait until no autovacuum worker has run for
 * a while. Without this, the dirty pages and vacuum of the previous step are measured as if they were ours.
 */
export async function settle(sql: Sql, quietSeconds = 8, maxSeconds = 240): Promise<number> {
  const t0 = performance.now();
  await sql`CHECKPOINT`;
  let quietSince = performance.now();
  while ((performance.now() - t0) / 1000 < maxSeconds) {
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'`;
    if (r!.n > 0) quietSince = performance.now();
    if ((performance.now() - quietSince) / 1000 >= quietSeconds) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  return Math.round(performance.now() - t0);
}

/**
 * A fixed CPU task run inside Postgres. The host this spike runs on is a shared laptop, so every result carries
 * this number: a result measured while it was slow can be recognised (and re-run) instead of trusted.
 */
export async function calibrate(sql: Sql): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await sql`SELECT count(*) FROM generate_series(1, 4000000) g WHERE g % 7 = 0 AND md5(g::text) > '8'`;
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return Math.round(runs[2]!);
}

/** Restart the throwaway container so shared_buffers starts empty. */
export async function restartSpikeContainer(name = "wb2003-pg"): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  execFileSync("docker", ["restart", name], { stdio: "ignore" });
  const url = process.env.WB_SPIKE_DATABASE_URL ?? DEFAULT_URL;
  assertSafeDatabaseUrl(url);
  for (let i = 0; i < 60; i++) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
      await probe`SELECT 1`;
      await probe.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Postgres did not come back after restart");
}

/** Names of the secondary (non-primary-key) indexes currently on workbook_cells, for labelling results. */
export async function appliedIndexes(sql: Sql, v: Variant): Promise<string[]> {
  const cells = tables(v).cells;
  const rows = await sql.unsafe<{ name: string }[]>(
    `SELECT DISTINCT regexp_replace(i.indexrelid::regclass::text, '^.*\\.', '') AS name
     FROM pg_index i WHERE i.indrelid = '${cells}'::regclass AND NOT i.indisprimary ORDER BY 1`
  );
  return rows.map((r) => r.name);
}
