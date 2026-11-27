import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

/**
 * PAPI-010 against a real, migrated Postgres (COPS_TEST_DATABASE_URL): the api_keys constraints
 * from public API PRD §10 hold at the database level, not only in the service.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("PAPI-010 api_keys table", () => {
  let sql: ReturnType<typeof postgres>;
  let ws: string;

  const prefix = () => randomBytes(6).toString("hex");
  const insert = (over: { type?: string; prefix?: string; expiresIn?: string | null; graceIn?: string | null; dailyCap?: number }) => {
    const expires = over.expiresIn === null ? null : sql`now() + ${over.expiresIn ?? "90 days"}::interval`;
    const grace = over.graceIn ? sql`now() + ${over.graceIn}::interval` : null;
    return sql`
      insert into api_keys (workspace_id, name, type, prefix, key_hmac, expires_at, grace_until, daily_credit_cap, created_at)
      values (${ws}, 'test key', ${over.type ?? "live"}, ${over.prefix ?? prefix()}, 'hmac', ${expires}, ${grace}, ${over.dailyCap ?? null}, now())
      returning id`;
  };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    ws = randomUUID();
    await sql`insert into workspaces (id, name, slug) values (${ws}, 'PAPI-010 test', ${"papi010-" + ws})`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql.end();
  });

  it("accepts a key that expires exactly 90 days after creation, with defaults filled in", async () => {
    const [row] = await insert({ expiresIn: "90 days" });
    const [key] = await sql`select scopes, ip_allowlist, expiry_reminders_sent, revoked_at from api_keys where id = ${row!.id}`;
    expect(key).toMatchObject({ scopes: [], ip_allowlist: [], expiry_reminders_sent: {}, revoked_at: null });
  });

  it("rejects a 91-day expiry, a missing expiry and an expiry in the past", async () => {
    await expect(insert({ expiresIn: "91 days" })).rejects.toThrow(/api_keys_expiry_max_90_days_check/);
    await expect(insert({ expiresIn: null })).rejects.toThrow(/null value in column "expires_at"/);
    await expect(insert({ expiresIn: "-1 day" })).rejects.toThrow(/api_keys_expiry_max_90_days_check/);
  });

  it("rejects a rotation grace period past the key's own expiry", async () => {
    await expect(insert({ expiresIn: "1 day", graceIn: "7 days" })).rejects.toThrow(/api_keys_grace_within_expiry_check/);
    await expect(insert({ expiresIn: "30 days", graceIn: "7 days" })).resolves.toHaveLength(1);
  });

  it("allows only live/test keys with a 12-hex prefix, unique across workspaces", async () => {
    await expect(insert({ type: "cops" })).rejects.toThrow(/api_keys_type_check/);
    await expect(insert({ prefix: "ABCDEF123456" })).rejects.toThrow(/api_keys_prefix_format_check/);
    await expect(insert({ prefix: "abc" })).rejects.toThrow(/api_keys_prefix_format_check/);
    const p = prefix();
    await insert({ type: "test", prefix: p });
    await expect(insert({ prefix: p })).rejects.toThrow(/api_keys_prefix_uq/);
  });

  it("rejects negative credit caps", async () => {
    await expect(insert({ dailyCap: -1 })).rejects.toThrow(/api_keys_caps_check/);
  });

  it("has the workspace/revoked_at index for active-key lookups", async () => {
    const [idx] = await sql`select indexdef from pg_indexes where indexname = 'api_keys_workspace_revoked_idx'`;
    expect(idx!.indexdef).toContain("(workspace_id, revoked_at)");
  });
});
