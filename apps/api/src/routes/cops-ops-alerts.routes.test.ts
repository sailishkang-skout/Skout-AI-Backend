import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { alertEventId, basicAuthPassword, secretMatches } from "./cops-ops-alerts.routes.js";

/**
 * COPS-07: operational alerts (GCP Cloud Monitoring incidents) reach the web app through a webhook
 * with basic auth. Fails closed without configuration, refuses wrong credentials, notifies Admin,
 * owner and Engineering once per incident state, and needs no session.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const stamp = Date.now();
const OWNER = `ops-alert-owner-${stamp}@example.test`;
const SECRET = "test-ops-alert-webhook-secret";
const basic = (password: string) => `Basic ${Buffer.from(`skout:${password}`).toString("base64")}`;
// The shape Cloud Monitoring sends (payload version 1.2), trimmed to what the route reads.
const incident = (state: "open" | "closed") => ({
  version: "1.2",
  incident: {
    incident_id: `inc-${stamp}`,
    state,
    policy_name: "[CustomerOps] A workflow health metric is critical",
    condition_name: "outbox_lag_seconds critical",
    summary: "outbox_lag_seconds is critical. Runbook: docs/runbooks/cops-platform.md",
    url: "https://console.cloud.google.com/monitoring/alerting/incidents/inc",
  },
});

describe("ops alert webhook helpers", () => {
  it("compares secrets without leaking length, and refuses a missing one", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches("wrong", SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches(SECRET, undefined)).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  it("reads the password of a basic-auth header", () => {
    expect(basicAuthPassword(basic("p:w"))).toBe("p:w");
    expect(basicAuthPassword("Bearer x")).toBeNull();
    expect(basicAuthPassword(undefined)).toBeNull();
  });

  it("gives one id per incident state", () => {
    expect(alertEventId("i1", "open")).toBe(alertEventId("i1", "open"));
    expect(alertEventId("i1", "open")).not.toBe(alertEventId("i1", "closed"));
    expect(alertEventId("i1", "open")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

maybe("ops alert webhook", () => {
  let app: FastifyInstance;
  let unconfigured: FastifyInstance;
  let sql: any;
  let workspaceId = "";

  const build = async (extra: Record<string, unknown>) => {
    const config = loadEnv();
    const built = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, ...extra } as typeof config);
    await built.ready();
    return built;
  };
  const post = (target: FastifyInstance, body: unknown, password?: string) =>
    target.inject({ method: "POST", url: "/api/v1/webhooks/ops-alerts", headers: password ? { authorization: basic(password) } : {}, payload: body as object });

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    unconfigured = await build({ OPS_ALERT_WEBHOOK_SECRET: undefined, OPS_ALERT_WORKSPACE_ID: undefined });
    // The first call as a new user creates their workspace, with them as its owner.
    workspaceId = ((await unconfigured.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": OWNER } })).json() as { workspaceId: string }).workspaceId;
    app = await build({ OPS_ALERT_WEBHOOK_SECRET: SECRET, OPS_ALERT_WORKSPACE_ID: workspaceId });
  });

  afterAll(async () => {
    await app?.close();
    await unconfigured?.close();
    await sql?.end();
  });

  it("refuses every call when the secret or the workspace is not configured", async () => {
    expect((await post(unconfigured, incident("open"), SECRET)).statusCode).toBe(503);
  });

  it("refuses missing or wrong credentials, with no session needed for the right ones", async () => {
    expect((await post(app, incident("open"))).statusCode).toBe(401);
    expect((await post(app, incident("open"), "not-the-secret")).statusCode).toBe(401);
    expect((await post(app, { incident: { state: "open" } }, SECRET)).statusCode).toBe(422);
  });

  it("notifies the Admin, owner and Engineering members once per incident state", async () => {
    const first = await post(app, incident("open"), SECRET);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, created: first.json().recipients });
    expect(first.json().recipients).toBeGreaterThan(0);
    // A retried delivery notifies nobody twice.
    expect((await post(app, incident("open"), SECRET)).json()).toMatchObject({ created: 0 });
    const rows = await sql`select n.type, n.title, n.body, u.email from notifications n join users u on u.id = n.user_id where n.workspace_id = ${workspaceId} and n.entity_id = ${`inc-${stamp}`}`;
    expect(rows).toHaveLength(first.json().recipients);
    expect(rows.find((r: { email: string }) => r.email === OWNER)).toMatchObject({ type: "cops.ops_alert", title: "[Alert] [CustomerOps] A workflow health metric is critical" });
    expect(rows[0].body).toContain("Runbook");
    // The incident closing is a new state and is told once too.
    expect((await post(app, incident("closed"), SECRET)).json().created).toBe(first.json().recipients);
  });
});
