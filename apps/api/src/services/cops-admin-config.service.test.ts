import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { COPS_CONFIG_SCHEMAS } from "@skout/shared";
import { getConfig, listConfig, listConfigVersions, rollbackConfig, saveConfig, type AdminConfigContext } from "./cops-admin-config.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

describe("COPS-07 config schemas", () => {
  it("audit logs cannot be kept for less than a year", () => {
    const bad = COPS_CONFIG_SCHEMAS.retention_policy.safeParse({ categories: { audit_logs: { days: 90 }, communications: { days: 180 } } });
    expect(bad.success).toBe(false);
    expect(COPS_CONFIG_SCHEMAS.retention_policy.safeParse({ categories: { audit_logs: { days: 365 }, communications: { days: null } } }).success).toBe(true);
  });

  it("rejects unknown fields and out-of-range trial templates", () => {
    const base = { name: "Trial", plan: "trial", trial_days: 14, credits: 500, integrations: ["crm"] };
    expect(COPS_CONFIG_SCHEMAS.trial_template.safeParse(base).success).toBe(true);
    expect(COPS_CONFIG_SCHEMAS.trial_template.safeParse({ ...base, trial_days: 400 }).success).toBe(false);
    expect(COPS_CONFIG_SCHEMAS.trial_template.safeParse({ ...base, discount: 50 }).success).toBe(false);
  });
});

/**
 * COPS-07 admin config store against a real Postgres: an edit is a new version, history is kept,
 * rollback writes a new version, concurrent saves never share a version, every write is audited,
 * rows cannot be updated, and one workspace never reads another's config.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-07 admin config store (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: AdminConfigContext;
  const trial = (days: number) => ({ name: "Standard trial", plan: "trial", trial_days: days, credits: 500, integrations: ["crm", "email"] });

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Config ops', ${"cfg-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`admin-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("shows the built-in default as version 0 until the workspace saves its own", async () => {
    const before = await getConfig(db, ctx.workspaceId, "trial_template", "standard");
    expect(before).toMatchObject({ version: 0, is_system_default: true, value: { trial_days: 14 } });
    expect(await getConfig(db, ctx.workspaceId, "credit_package", "starter")).toBeNull();
    const flags = await listConfig(db, ctx.workspaceId, "feature_flags");
    expect(flags[0]).toMatchObject({ key: "default", is_system_default: true, value: { modules: { tickets: true } } });
  });

  it("an edit is a new version; the old version stays readable; the write is audited with its reason", async () => {
    const v1 = await saveConfig(db, ctx, "trial_template", "standard", { value: trial(14), reason: "Initial template" });
    const v2 = await saveConfig(db, ctx, "trial_template", "standard", { value: trial(21), reason: "Longer trials for Q4", expected_version: 1 });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await getConfig(db, ctx.workspaceId, "trial_template", "standard"))!.value).toMatchObject({ trial_days: 21 });
    const history = await listConfigVersions(db, ctx.workspaceId, "trial_template", "standard");
    expect(history.map((h) => [h.version, (h.value as { trial_days: number }).trial_days])).toEqual([[2, 21], [1, 14]]);
    const audits = await sql`select action, reason, before_state, after_state from audit_logs where workspace_id = ${ctx.workspaceId} and action = 'admin_config.saved' order by created_at`;
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ reason: "Longer trials for Q4", before_state: { version: 1 }, after_state: { version: 2, kind: "trial_template", key: "standard" } });
  });

  it("a stale editor gets a conflict, and an invalid value or key is refused with field paths", async () => {
    await expect(saveConfig(db, ctx, "trial_template", "standard", { value: trial(30), reason: "x", expected_version: 1 })).rejects.toMatchObject({
      code: "BUSINESS_STATE_CONFLICT",
      status: 409,
      details: { current_version: 2 },
    });
    const bad = await saveConfig(db, ctx, "trial_template", "standard", { value: { ...trial(14), trial_days: 0 }, reason: "x" }).catch((e) => e);
    expect(bad).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(bad.details.fields[0].path).toBe("value.trial_days");
    await expect(saveConfig(db, ctx, "trial_template", "Bad Key!", { value: trial(14), reason: "x" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rollback writes a new version with the old value and keeps the history", async () => {
    const restored = await rollbackConfig(db, ctx, "trial_template", "standard", { version: 1, reason: "Q4 experiment ended" });
    expect(restored).toMatchObject({ version: 3, restored_from_version: 1, value: { trial_days: 14 } });
    expect((await listConfigVersions(db, ctx.workspaceId, "trial_template", "standard")).length).toBe(3);
    await expect(rollbackConfig(db, ctx, "trial_template", "standard", { version: 99, reason: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [audit] = await sql`select reason from audit_logs where workspace_id = ${ctx.workspaceId} and action = 'admin_config.rolled_back'`;
    expect(audit.reason).toBe("Q4 experiment ended");
  });

  it("concurrent saves take different versions", async () => {
    const pkg = (credits: number) => ({ name: "Starter", credits, price_minor: 9900, currency: "USD", active: true });
    const results = await Promise.all([1, 2, 3, 4].map((n) => saveConfig(db, ctx, "credit_package", "starter", { value: pkg(n * 100), reason: `save ${n}` })));
    expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3, 4]);
  });

  it("saved versions cannot be edited in place", async () => {
    await expect(sql`update cops_config_versions set value = '{}'::jsonb where workspace_id = ${ctx.workspaceId}`).rejects.toThrow(/immutable/);
  });

  it("another workspace reads only its own config", async () => {
    const [ws2] = await sql`insert into workspaces (name, slug) values ('Other config', ${"cfg2-" + randomUUID()}) returning id`;
    expect((await getConfig(db, ws2.id, "trial_template", "standard"))!.is_system_default).toBe(true);
    expect(await listConfig(db, ws2.id, "credit_package")).toEqual([]);
    expect(await listConfigVersions(db, ws2.id, "trial_template", "standard")).toEqual([]);
  });
});
