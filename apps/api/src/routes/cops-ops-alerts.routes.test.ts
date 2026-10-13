import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { alertEventId, secretMatches } from "./cops-ops-alerts.routes.js";

/**
 * COPS-07: Datadog monitors reach the web app through a signed webhook. Fails closed without
 * configuration, refuses a wrong secret, notifies Admin, owner and Engineering once per state
 * change, and needs no session.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const stamp = Date.now();
const OWNER = `ops-alert-owner-${stamp}@example.test`;
const SECRET = "test-datadog-webhook-secret";
const alert = { alert_id: `mon-${stamp}`, cycle_key: "c1", transition: "Triggered", title: "[CustomerOps] outbox_lag_seconds is critical (production)", body: "Outbox lag is over 300 seconds.", link: "https://app.us5.datadoghq.com/monitors/1" };

describe("Datadog alert webhook helpers", () => {
  it("compares secrets without leaking length, and refuses a missing one", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches("wrong", SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches(SECRET, undefined)).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  it("gives one id per monitor state change", () => {
    expect(alertEventId("m1", "c1", "Triggered")).toBe(alertEventId("m1", "c1", "Triggered"));
    expect(alertEventId("m1", "c1", "Triggered")).not.toBe(alertEventId("m1", "c1", "Recovered"));
    expect(alertEventId("m1", "c1", "Triggered")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

maybe("Datadog alert webhook", () => {
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
  const post = (target: FastifyInstance, body: unknown, secret?: string) =>
    target.inject({ method: "POST", url: "/api/v1/webhooks/datadog/cops-alerts", headers: secret ? { "x-skout-webhook-secret": secret } : {}, payload: body as object });

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    unconfigured = await build({ DATADOG_WEBHOOK_SECRET: undefined, OPS_ALERT_WORKSPACE_ID: undefined });
    // The first call as a new user creates their workspace, with them as its owner.
    workspaceId = ((await unconfigured.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": OWNER } })).json() as { workspaceId: string }).workspaceId;
    app = await build({ DATADOG_WEBHOOK_SECRET: SECRET, OPS_ALERT_WORKSPACE_ID: workspaceId });
  });

  afterAll(async () => {
    await app?.close();
    await unconfigured?.close();
    await sql?.end();
  });

  it("refuses every call when the secret or the workspace is not configured", async () => {
    expect((await post(unconfigured, alert, SECRET)).statusCode).toBe(503);
  });

  it("refuses a missing or wrong secret, with no session needed for a right one", async () => {
    expect((await post(app, alert)).statusCode).toBe(401);
    expect((await post(app, alert, "not-the-secret")).statusCode).toBe(401);
    expect((await post(app, { transition: "Triggered" }, SECRET)).statusCode).toBe(422);
  });

  it("notifies the Admin, owner and Engineering members once per state change", async () => {
    const first = await post(app, alert, SECRET);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, created: first.json().recipients });
    expect(first.json().recipients).toBeGreaterThan(0);
    // Datadog retries: nobody is notified twice.
    expect((await post(app, alert, SECRET)).json()).toMatchObject({ created: 0 });
    const rows = await sql`select n.type, n.title, n.body, u.email from notifications n join users u on u.id = n.user_id where n.workspace_id = ${workspaceId} and n.entity_id = ${alert.alert_id}`;
    expect(rows).toHaveLength(first.json().recipients);
    expect(rows.find((r: { email: string }) => r.email === OWNER)).toMatchObject({ type: "cops.ops_alert", title: `[Triggered] ${alert.title}` });
    expect(rows[0].body).toContain(alert.link);
    // The recovery is a new state change and is told once too.
    expect((await post(app, { ...alert, transition: "Recovered" }, SECRET)).json().created).toBe(first.json().recipients);
  });
});
