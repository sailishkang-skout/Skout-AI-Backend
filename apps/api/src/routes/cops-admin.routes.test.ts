import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-07 admin routes against a real Postgres: admin-only writes, versioned saves over HTTP, the
 * module switch refusing a turned-off module, activation definitions as new versions, and the
 * retention dry-run-first rule.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const OWNER = `adm-owner-${Date.now().toString(36)}@example.test`;

maybe("COPS-07 admin routes", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let userId = "";

  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": OWNER, ...(method !== "GET" && key ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  async function asRole(roleKey: string) {
    const [role] = await sql`select id from roles where key = ${roleKey} and workspace_id is null`;
    await sql`delete from workspace_member_roles where workspace_id = ${workspaceId} and user_id = ${userId}`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${workspaceId}, ${userId}, ${role.id})`;
  }

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    const [u] = await sql`select id from users where email = ${OWNER}`;
    userId = u.id;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  const trial = { name: "Standard trial", plan: "trial", trial_days: 21, credits: 750, integrations: ["crm"] };

  it("only an admin writes config; Product reads it; Sales sees neither but reads the trial catalog", async () => {
    await asRole("owner");
    const noKey = await call("PUT", "/admin/config/trial_template/standard", { value: trial, reason: "x" }, null);
    expect(noKey.statusCode).toBe(422);
    const saved = await call("PUT", "/admin/config/trial_template/standard", { value: trial, reason: "Longer trials" });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().data).toMatchObject({ version: 1, value: { trial_days: 21 } });
    expect((await call("PUT", "/admin/config/trial_template/standard", { value: trial })).statusCode).toBe(422);
    expect((await call("PUT", "/admin/config/unknown_kind/x", { value: {}, reason: "x" })).statusCode).toBe(422);
    const bad = await call("PUT", "/admin/config/trial_template/standard", { value: { ...trial, trial_days: 500 }, reason: "x" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.fields[0].path).toBe("value.trial_days");

    await asRole("product");
    expect((await call("GET", "/admin/config/trial_template")).json().data[0]).toMatchObject({ key: "standard", version: 1 });
    expect((await call("PUT", "/admin/config/trial_template/standard", { value: trial, reason: "x" })).statusCode).toBe(403);
    expect((await call("GET", "/admin/config/trial_template/standard/versions")).json().data).toHaveLength(1);

    await asRole("sales");
    expect((await call("GET", "/admin/config/trial_template")).statusCode).toBe(403);
    expect((await call("GET", "/admin/ops/metrics")).statusCode).toBe(403);
    expect((await call("GET", "/trial-templates")).json().data[0]).toMatchObject({ key: "standard", trial_days: 21, credits: 750 });
  });

  it("rollback over HTTP writes a new version", async () => {
    await asRole("owner");
    await call("PUT", "/admin/config/trial_template/standard", { value: { ...trial, trial_days: 30 }, reason: "Try 30" });
    const back = await call("POST", "/admin/config/trial_template/standard/rollback", { version: 1, reason: "30 was too long" });
    expect(back.statusCode).toBe(201);
    expect(back.json().data).toMatchObject({ version: 3, restored_from_version: 1, value: { trial_days: 21 } });
    expect((await call("POST", "/admin/config/trial_template/standard/rollback", { version: 42, reason: "x" })).statusCode).toBe(404);
  });

  it("a module turned off refuses its routes, and turning it back on restores them", async () => {
    await asRole("owner");
    expect((await call("GET", "/tickets")).statusCode).toBe(200);
    await call("PUT", "/admin/config/feature_flags/default", { value: { modules: { tickets: false } }, reason: "Pause tickets" });
    const off = await call("GET", "/tickets");
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ code: "FORBIDDEN", details: { reason: "module_disabled", module: "tickets" } });
    expect((await call("GET", "/cops/modules")).json().data).toMatchObject({ tickets: false, commercial: true, admin: true });
    // Other modules and the admin API itself keep working.
    expect((await call("GET", "/follow-up/queue")).statusCode).toBe(200);
    await call("PUT", "/admin/config/feature_flags/default", { value: { modules: { tickets: true } }, reason: "Resume tickets" });
    expect((await call("GET", "/tickets")).statusCode).toBe(200);
  });

  it("an activation definition change is a new version; bad weights and login-only activation are refused", async () => {
    await asRole("owner");
    const m = (key: string, weight: number, required: boolean) => ({ key, label: key, weight, required, source: "event", event_types: ["product." + key] });
    const login = await call("POST", "/admin/activation-templates/default_trial/versions", { milestones: [m("first_login", 100, true)], reason: "x" });
    expect(login.statusCode).toBe(422);
    const weights = await call("POST", "/admin/activation-templates/default_trial/versions", { milestones: [m("first_search", 40, true)], reason: "x" });
    expect(weights.statusCode).toBe(422);
    expect(weights.json().message).toContain("100");
    const ok = await call("POST", "/admin/activation-templates/default_trial/versions", { milestones: [m("first_search", 60, true), m("first_export", 40, true)], reason: "Search matters more" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.version).toBeGreaterThan(1);
    const list = (await call("GET", "/admin/activation-templates")).json().data as Array<{ key: string; version: number; is_system_default: boolean }>;
    expect(list.some((t) => t.key === "default_trial" && t.is_system_default && t.version === 1)).toBe(true);
    expect(list.some((t) => t.key === "default_trial" && !t.is_system_default && t.version === ok.json().data.version)).toBe(true);
    const [audit] = await sql`select reason from audit_logs where workspace_id = ${workspaceId} and action = 'activation_template.version_created'`;
    expect(audit.reason).toBe("Search matters more");
  });

  it("retention over HTTP: dry run first, apply needs it; inventory and metrics are readable by an admin", async () => {
    await asRole("owner");
    expect((await call("POST", "/admin/retention/runs", { mode: "apply", reason: "x" })).statusCode).toBe(409);
    const dry = await call("POST", "/admin/retention/runs", { mode: "dry_run" });
    expect(dry.statusCode).toBe(201);
    const applied = await call("POST", "/admin/retention/runs", { mode: "apply", dry_run_id: dry.json().data.id, reason: "Nothing configured, nothing removed" });
    expect(applied.statusCode).toBe(201);
    expect(applied.json().data.total_rows).toBe(0);
    const runs = await call("GET", "/admin/retention/runs");
    expect(runs.json().data.length).toBeGreaterThanOrEqual(2);
    expect(runs.json().targets.map((t: { table: string }) => t.table)).toContain("audit_logs");
    expect((await call("GET", "/admin/data-inventory")).json().data.length).toBeGreaterThan(100);
    expect((await call("GET", "/admin/ops/metrics")).json().data.metrics.length).toBe(12);
  });
});
