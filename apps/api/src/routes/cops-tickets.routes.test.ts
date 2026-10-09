import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-06 ticket routes against a real Postgres: who may read the queue, create, work and publish
 * (Sales create from an account but cannot open the queue; Engineering works a ticket but cannot
 * publish to the customer; CS publishes), Idempotency-Key on create, and the error envelope.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const OWNER = `tkt-owner-${Date.now().toString(36)}@example.test`;

maybe("COPS-06 ticket routes", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let userId = "";
  let accountId = "";

  const call = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": OWNER, ...(method === "POST" && key ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  async function asRole(roleKey: string) {
    const [role] = await sql`select id from roles where key = ${roleKey} and workspace_id is null`;
    await sql`delete from workspace_member_roles where workspace_id = ${workspaceId} and user_id = ${userId}`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${workspaceId}, ${userId}, ${role.id})`;
  }

  async function ticket(body: Record<string, unknown> = {}) {
    await asRole("cs");
    const res = await call("POST", "/tickets", { account_id: accountId, title: "Sync fails", ...body });
    expect(res.statusCode).toBe(201);
    return res.json().data.id as string;
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
    const [co] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, 'Ticket Co') returning id`;
    accountId = co.id;
    // The seeded grant (packages/db cops-role-grants); a database seeded before COPS-06 lacks it.
    await sql`insert into role_permissions (role_id, permission_key) select id, 'tickets:send' from roles where key = 'cs' and workspace_id is null on conflict do nothing`;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it("create needs an Idempotency-Key, validates the body, and a replay creates one ticket", async () => {
    await asRole("cs");
    const noKey = await call("POST", "/tickets", { account_id: accountId, title: "x" }, null);
    expect(noKey.statusCode).toBe(422);
    const bad = await call("POST", "/tickets", { account_id: accountId, title: "", severity: "sev9" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("VALIDATION_FAILED");
    const missing = await call("POST", "/tickets", { account_id: randomUUID(), title: "x" });
    expect(missing.statusCode).toBe(404);

    const key = randomUUID();
    const first = await call("POST", "/tickets", { account_id: accountId, title: "Replay me" }, key);
    const again = await call("POST", "/tickets", { account_id: accountId, title: "Replay me" }, key);
    expect(first.statusCode).toBe(201);
    expect(again.json().data.id).toBe(first.json().data.id);
    const [n] = await sql`select count(*)::int as n from engineering_tickets where workspace_id = ${workspaceId} and title = 'Replay me'`;
    expect(n.n).toBe(1);
  });

  it("Sales create from an account and see its Engineering tab, but cannot open the queue or a ticket", async () => {
    await asRole("sales");
    const prefill = await call("GET", `/tickets/prefill?account_id=${accountId}&blocker=integration_error`);
    expect(prefill.statusCode).toBe(200);
    expect(prefill.json().data).toMatchObject({ category: "integration", severity: "high" });
    const created = await call("POST", "/tickets", { account_id: accountId, title: "Raised by sales" });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;

    expect((await call("GET", "/tickets")).statusCode).toBe(403);
    expect((await call("GET", `/tickets/${id}`)).statusCode).toBe(403);
    expect((await call("POST", `/tickets/${id}/transition`, { to: "triage" })).statusCode).toBe(403);
    const tab = await call("GET", `/accounts/${accountId}/tickets`);
    expect(tab.statusCode).toBe(200);
    expect(tab.json().data.summary.open_count).toBeGreaterThan(0);
  });

  it("Engineering works the ticket and adds notes but cannot publish to the customer; CS can", async () => {
    const id = await ticket();
    await asRole("engineering");
    expect((await call("GET", "/tickets?open=true&severity=medium")).json().data.map((t: { id: string }) => t.id)).toContain(id);
    expect((await call("POST", `/tickets/${id}/transition`, { to: "triage" })).statusCode).toBe(200);
    const skip = await call("POST", `/tickets/${id}/transition`, { to: "verified" });
    expect(skip.statusCode).toBe(409);
    expect(skip.json().code).toBe("BUSINESS_STATE_CONFLICT");

    const note = await call("POST", `/tickets/${id}/comments`, { body: "Root cause: token refresh", visibility: "internal" });
    expect(note.statusCode).toBe(201);
    const noVisibility = await call("POST", `/tickets/${id}/comments`, { body: "x" });
    expect(noVisibility.statusCode).toBe(422);
    const publish = await call("POST", `/tickets/${id}/comments`, { body: "Fixed", visibility: "customer" });
    expect(publish.statusCode).toBe(403);
    expect(publish.json().details.required_permission).toBe("tickets:send");
    const flip = await call("PATCH", `/tickets/${id}/comments/${note.json().data.id}/visibility`, { visibility: "customer", reason: "share" });
    expect(flip.statusCode).toBe(403);

    await asRole("cs");
    const update = await call("POST", `/tickets/${id}/comments`, { body: "We found the cause and are fixing it", visibility: "customer" });
    expect(update.statusCode).toBe(201);
    const safe = (await call("GET", `/tickets/${id}/customer-view`)).json().data;
    expect(safe.updates.map((u: { body: string }) => u.body)).toEqual(["We found the cause and are fixing it"]);
    expect(JSON.stringify(safe)).not.toContain("token refresh");
  });

  it("escalation needs a reason and a higher severity; another workspace's ticket is a 404", async () => {
    const id = await ticket({ severity: "medium" });
    expect((await call("POST", `/tickets/${id}/escalate`, { severity: "critical" })).statusCode).toBe(422);
    expect((await call("POST", `/tickets/${id}/escalate`, { severity: "low", reason: "x" })).statusCode).toBe(409);
    const ok = await call("POST", `/tickets/${id}/escalate`, { severity: "critical", reason: "Go-live blocked" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().summary.max_severity).toBe("critical");

    const [ws] = await sql`insert into workspaces (name, slug) values ('Other', ${"tkt-other-" + randomUUID()}) returning id`;
    const [co] = await sql`insert into companies (workspace_id, name) values (${ws.id}, 'Other co') returning id`;
    const [foreign] = await sql`insert into engineering_tickets (workspace_id, account_id, title) values (${ws.id}, ${co.id}, 'Not yours') returning id`;
    expect((await call("GET", `/tickets/${foreign.id}`)).statusCode).toBe(404);
    expect((await call("GET", `/accounts/${co.id}/tickets`)).statusCode).toBe(404);
  });
});
