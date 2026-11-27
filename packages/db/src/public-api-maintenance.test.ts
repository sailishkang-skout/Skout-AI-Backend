import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDb, type Db } from "./client.js";
import { maintainPublicApiTables } from "./public-api-maintenance.js";

/**
 * PAPI-012 against a real, migrated Postgres (COPS_TEST_DATABASE_URL): the new public API tables,
 * monthly request-log partitions with 90-day retention, and the 24-hour idempotency purge.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("PAPI-012 public API tables and maintenance", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;
  let close: () => Promise<void>;
  let ws: string;

  const partitions = async () =>
    (
      await sql`select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
                where i.inhparent = 'api_request_log'::regclass order by c.relname`
    ).map((r) => r.relname as string);

  beforeAll(async () => {
    const c = createDb(url as string);
    db = c.db;
    close = () => c.sql.end();
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    ws = randomUUID();
    await sql`insert into workspaces (id, name, slug) values (${ws}, 'PAPI-012 test', ${"papi012-" + ws})`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`drop table if exists api_request_log_y2020m01, api_request_log_y2020m02`;
    await sql.end();
    await close();
  });

  it("keeps request-log partitions for this month and the next three", async () => {
    await maintainPublicApiTables(db);
    const names = await partitions();
    const now = new Date();
    for (let i = 0; i <= 3; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const name = `api_request_log_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      expect(names).toContain(name);
    }
    // Running again creates nothing new.
    expect((await maintainPublicApiTables(db)).partitionsCreated).toBe(0);
  });

  it("routes rows to the right month and stores price_applied", async () => {
    const [row] = await sql`
      insert into api_request_log (request_id, workspace_id, method, endpoint, status_code, credits_charged, price_applied)
      values ('req_log_1', ${ws}, 'POST', '/people/search', 200, 3, ${sql.json({ "search.index_page": 1, "search.vendor_result": 1 })})
      returning tableoid::regclass::text as part, price_applied`;
    const now = new Date();
    expect(row!.part).toBe(`api_request_log_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
    expect(row!.price_applied).toEqual({ "search.index_page": 1, "search.vendor_result": 1 });
    // A rejected request with no resolvable key is still logged.
    await sql`insert into api_request_log (request_id, method, endpoint, status_code, error_code) values ('req_log_2', 'GET', '/usage', 401, 'authentication_failed')`;
    await expect(
      sql`insert into api_request_log (request_id, method, endpoint, status_code, credits_charged) values ('r', 'GET', '/x', 200, -1)`
    ).rejects.toThrow(/api_request_log_credits_check/);
  });

  it("drops partitions once their whole month is older than 90 days, and nothing newer", async () => {
    await sql`select api_request_log_ensure_partitions('2020-01-15T00:00:00Z', 1)`;
    expect(await partitions()).toEqual(expect.arrayContaining(["api_request_log_y2020m01", "api_request_log_y2020m02"]));
    // On 2020-05-01 the cutoff is 2020-02-01: January (ends Feb 1) goes, February (ends Mar 1) stays.
    const early = await maintainPublicApiTables(db, new Date("2020-05-01T00:00:00Z"));
    expect(early.partitionsDropped).toEqual(["api_request_log_y2020m01"]);
    const later = await maintainPublicApiTables(db);
    expect(later.partitionsDropped).toContain("api_request_log_y2020m02");
    const names = await partitions();
    expect(names.some((n) => n.startsWith("api_request_log_y2020"))).toBe(false);
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  it("purges idempotency records older than 24 hours only", async () => {
    await sql`
      insert into api_idempotency (workspace_id, key, request_hash, created_at) values
        (${ws}, 'old', 'h1', now() - interval '25 hours'),
        (${ws}, 'fresh', 'h2', now() - interval '23 hours')`;
    const r = await maintainPublicApiTables(db);
    expect(r.idempotencyPurged).toBeGreaterThanOrEqual(1);
    const keys = (await sql`select key from api_idempotency where workspace_id = ${ws}`).map((x) => x.key);
    expect(keys).toEqual(["fresh"]);
    await expect(sql`insert into api_idempotency (workspace_id, key, request_hash) values (${ws}, 'fresh', 'h3')`).rejects.toThrow(
      /api_idempotency_pk/
    );
  });

  it("enforces job statuses and counts", async () => {
    await expect(
      sql`insert into api_jobs (workspace_id, request_id, operation, status, total_items) values (${ws}, 'r1', 'emails.verify', 'done', 10)`
    ).rejects.toThrow(/api_jobs_status_check/);
    await expect(
      sql`insert into api_jobs (workspace_id, request_id, operation, total_items, processed_items) values (${ws}, 'r2', 'emails.verify', 10, 11)`
    ).rejects.toThrow(/api_jobs_counts_check/);
    const [job] = await sql`insert into api_jobs (workspace_id, request_id, operation, total_items) values (${ws}, 'r3', 'emails.verify', 1000) returning status`;
    expect(job!.status).toBe("queued");
  });

  it("stores terms acceptances and defaults the add-on to off", async () => {
    await sql`insert into api_terms_acceptances (workspace_id, terms_version, ip) values (${ws}, '2026-11-25', '203.0.113.7')`;
    const [s] = await sql`insert into workspace_api_settings (workspace_id) values (${ws}) returning addon_enabled, live_access_for_trial, rate_tier`;
    expect(s).toEqual({ addon_enabled: false, live_access_for_trial: false, rate_tier: "standard" });
    await expect(sql`update workspace_api_settings set verify_daily_quota = -5 where workspace_id = ${ws}`).rejects.toThrow(
      /workspace_api_settings_limits_check/
    );
  });

  it("removes a workspace's rows from every new table when the workspace is deleted", async () => {
    const other = randomUUID();
    await sql`insert into workspaces (id, name, slug) values (${other}, 'PAPI-012 cascade', ${"papi012c-" + other})`;
    await sql`insert into api_request_log (request_id, workspace_id, method, endpoint, status_code) values ('c1', ${other}, 'GET', '/usage', 200)`;
    await sql`insert into api_idempotency (workspace_id, key, request_hash) values (${other}, 'k', 'h')`;
    await sql`insert into api_jobs (workspace_id, request_id, operation, total_items) values (${other}, 'c2', 'emails.verify', 1)`;
    await sql`insert into api_terms_acceptances (workspace_id, terms_version) values (${other}, 'v1')`;
    await sql`insert into workspace_api_settings (workspace_id) values (${other})`;
    await sql`delete from workspaces where id = ${other}`;
    const [left] = await sql`
      select (select count(*) from api_request_log where workspace_id = ${other})::int
           + (select count(*) from api_idempotency where workspace_id = ${other})::int
           + (select count(*) from api_jobs where workspace_id = ${other})::int
           + (select count(*) from api_terms_acceptances where workspace_id = ${other})::int
           + (select count(*) from workspace_api_settings where workspace_id = ${other})::int as n`;
    expect(left!.n).toBe(0);
  });
});
