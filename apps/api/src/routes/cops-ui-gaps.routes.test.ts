import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * Endpoints the CustomerOps panel needed that the API did not offer yet (skout-customerops
 * docs/backend-gaps.md), against a real Postgres. Runs only when COPS_TEST_DATABASE_URL is set.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const OWNER = `gaps-owner-${Date.now().toString(36)}@example.test`;

maybe("CustomerOps panel gaps", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let userId = "";

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, key: string | null = randomUUID()) =>
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

  async function company(name: string) {
    const [row] = await sql`insert into companies (workspace_id, name, owner_id) values (${workspaceId}, ${name}, ${userId}) returning id`;
    return row.id as string;
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

  it("gap 2: Sales reads the price book; Engineering does not; nobody but an admin changes it", async () => {
    await asRole("sales");
    const book = await call("GET", "/price-book");
    expect(book.statusCode).toBe(200);
    expect(book.json().data).toMatchObject({ currencies: expect.any(Object), month_to_month_surcharge_pct: expect.any(Number) });
    expect(book.json().data.currency_policy).not.toBeNull();
    expect((await call("PUT", "/admin/config/price_book/default", { value: book.json().data, reason: "x" })).statusCode).toBe(403);
    await asRole("engineering");
    expect((await call("GET", "/price-book")).statusCode).toBe(403);
  });

  it("gap 3: the 360 header carries onboarding % from the activation instance", async () => {
    await asRole("owner");
    const accountId = await company("Gap Three Ltd");
    const before = await call("GET", `/accounts/${accountId}/360?fields=header`);
    expect(before.json().data.header.onboarding_pct).toBeNull();
    const [tpl] = await sql`select id, key, version from cops_activation_templates where workspace_id is null order by version desc limit 1`;
    await sql`insert into cops_onboarding_instances (workspace_id, account_id, template_id, template_key, template_version, activation_pct)
              values (${workspaceId}, ${accountId}, ${tpl.id}, ${tpl.key}, ${tpl.version}, 40)`;
    const after = await call("GET", `/accounts/${accountId}/360?fields=header`);
    expect(after.json().data.header.onboarding_pct).toBe(40);
  });

  it("gap 6: a published automation turns off and on, is audited, and a draft cannot be turned on", async () => {
    await asRole("owner");
    const draft = (await call("POST", "/automations", { name: "Draft only" })).json().data;
    const refused = await call("PATCH", `/automations/${draft.id}`, { status: "active" });
    expect(refused.statusCode).toBe(409);

    const auto = (await call("POST", "/automations", { name: "Low adoption playbook" })).json().data;
    const pub = await call("POST", `/automations/${auto.id}/versions/publish`, { graph: { nodes: [{ id: "n1", type: "delay", config: { seconds: 1 } }], edges: [] } });
    expect(pub.statusCode).toBe(201);
    const off = await call("PATCH", `/automations/${auto.id}`, { status: "paused" });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.status).toBe("paused");
    const on = await call("PATCH", `/automations/${auto.id}`, { status: "active" });
    expect(on.json().data.status).toBe("active");
    const audits = await sql`select action from audit_logs where workspace_id = ${workspaceId} and entity_id = ${auto.id} order by created_at`;
    expect(audits.map((a: { action: string }) => a.action)).toEqual(["automation.paused", "automation.activated"]);

    await asRole("sales");
    expect((await call("PATCH", `/automations/${auto.id}`, { status: "paused" })).statusCode).toBe(403);
  });

  it("gap 4: the workspace timeline lists every account, pages, filters and hides internal notes", async () => {
    await asRole("owner");
    const a = await company("Feed A");
    const b = await company("Feed B");
    const row = (account: string, type: string, visibility: string, minutes: number) =>
      sql`insert into cops_timeline_events (workspace_id, account_id, type, visibility, occurred_at, actor_type, source_event_id, event_type, summary)
          values (${workspaceId}, ${account}, ${type}, ${visibility}, now() - make_interval(mins => ${minutes}), 'user', ${randomUUID()}, 'cops.Test', ${type + " " + minutes})`;
    await row(a, "note", "internal", 1);
    await row(a, "email", "public", 2);
    await row(b, "call", "public", 3);

    const all = (await call("GET", "/cops/timeline?limit=2")).json();
    expect(all.data).toHaveLength(2);
    expect(all.data[0]).toMatchObject({ account_id: a, type: "note" });
    expect(all.next_cursor).toEqual(expect.any(String));
    const rest = (await call("GET", `/cops/timeline?limit=2&cursor=${all.next_cursor}`)).json();
    expect(rest.data.map((e: { account_id: string }) => e.account_id)).toContain(b);

    expect((await call("GET", `/cops/timeline?account_id=${b}`)).json().data.every((e: { account_id: string }) => e.account_id === b)).toBe(true);
    expect((await call("GET", "/cops/timeline?type=call")).json().data.every((e: { type: string }) => e.type === "call")).toBe(true);
    expect((await call("GET", "/cops/timeline?account_id=nope")).statusCode).toBe(422);

    await asRole("sales");
    const visible = (await call("GET", "/cops/timeline")).json().data;
    expect(visible.some((e: { visibility: string }) => e.visibility === "internal")).toBe(false);
  });
});
