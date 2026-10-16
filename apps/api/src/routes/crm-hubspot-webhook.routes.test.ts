import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import type { Db } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { ensureHubSpotPortalId, hubspotEventKey, verifyHubSpotWebhook } from "../services/crm-hubspot-webhook.service.js";
import { verifyHubSpotWebhookSignatureV3 } from "../services/hubspot.client.js";

/**
 * COPS-09 HubSpot webhook hardening (audit section 3.3) against a real Postgres
 * (COPS_TEST_DATABASE_URL): the workspace comes from the event's portal id, never the URL; each
 * event runs once; v3 signatures are checked with their timestamp.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const SECRET = "hubspot-test-client-secret";
const PUBLIC = "https://api.skout.test";
const stamp = Date.now();
const OWNER = `hubspot-owner-${stamp}@example.test`;
const OTHER = `hubspot-other-${stamp}@example.test`;
const PORTAL = String(900000 + (stamp % 99999));

const v1 = (body: string) => createHash("sha256").update(SECRET + body, "utf8").digest("hex");
const v3 = (method: string, uri: string, body: string, ts: number) => createHmac("sha256", SECRET).update(`${method}${uri}${body}${ts}`, "utf8").digest("base64");

describe("HubSpot webhook signatures", () => {
  const body = JSON.stringify([{ eventId: 1, portalId: 1 }]);
  const uri = `${PUBLIC}/api/v1/crm/hubspot/webhook`;
  const now = 1_790_000_000_000;

  it("checks v3 over method, full URL, body and timestamp, for five minutes", () => {
    const ok = { method: "POST", uri, rawBody: body, timestamp: String(now), signature: v3("POST", uri, body, now), nowMs: now };
    expect(verifyHubSpotWebhookSignatureV3(SECRET, ok)).toBe(true);
    // A different URL (another workspace id on the query, say) does not verify.
    expect(verifyHubSpotWebhookSignatureV3(SECRET, { ...ok, uri: `${uri}?workspaceId=x` })).toBe(false);
    expect(verifyHubSpotWebhookSignatureV3(SECRET, { ...ok, rawBody: body + " " })).toBe(false);
    expect(verifyHubSpotWebhookSignatureV3(SECRET, { ...ok, nowMs: now + 5 * 60_000 + 1 })).toBe(false);
    expect(verifyHubSpotWebhookSignatureV3(SECRET, { ...ok, timestamp: undefined })).toBe(false);
  });

  it("uses v3 when HubSpot sends it and v1 otherwise", () => {
    const headersV3 = { "x-hubspot-signature-v3": v3("POST", uri, body, now), "x-hubspot-request-timestamp": String(now) };
    expect(verifyHubSpotWebhook(SECRET, { method: "POST", uri, rawBody: body, headers: headersV3, nowMs: now })).toBe(true);
    // v3 cannot be checked without knowing the public URL.
    expect(verifyHubSpotWebhook(SECRET, { method: "POST", uri: null, rawBody: body, headers: headersV3, nowMs: now })).toBe(false);
    expect(verifyHubSpotWebhook(SECRET, { method: "POST", uri, rawBody: body, headers: { "x-hubspot-signature": v1(body) } })).toBe(true);
    expect(verifyHubSpotWebhook(SECRET, { method: "POST", uri, rawBody: body, headers: { "x-hubspot-signature": v1("other") } })).toBe(false);
  });

  it("turns a HubSpot event id into a stable UUID per portal", () => {
    expect(hubspotEventKey("1", "42")).toBe(hubspotEventKey("1", "42"));
    expect(hubspotEventKey("1", "42")).not.toBe(hubspotEventKey("2", "42"));
    expect(hubspotEventKey("1", "42")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

maybe("HubSpot webhook to workspace", () => {
  let app: FastifyInstance;
  let db: Db;
  let sql: any;
  let workspaceId = "";
  let otherWorkspaceId = "";

  const call = (method: "GET" | "POST", path: string, email = OWNER) =>
    app.inject({ method, url: `/api/v1${path}`, headers: { "x-stub-user-email": email } });
  const deliver = (events: unknown[], query = "") => {
    const body = JSON.stringify(events);
    return app.inject({ method: "POST", url: `/api/v1/crm/hubspot/webhook${query}`, headers: { "content-type": "application/json", "x-hubspot-signature": v1(body) }, payload: body });
  };

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, HUBSPOT_CLIENT_ID: "hubspot-test-client", HUBSPOT_CLIENT_SECRET: SECRET, API_PUBLIC_URL: PUBLIC } as typeof config);
    db = (app as unknown as { db: Db }).db;
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    otherWorkspaceId = ((await call("GET", "/me", OTHER)).json() as { workspaceId: string }).workspaceId;
    await sql`insert into crm_connections (workspace_id, provider, status, external_account_id, credentials_ref)
      values (${workspaceId}, 'hubspot', 'connected', ${PORTAL}, 'inline:none')`;
  });

  afterAll(async () => {
    if (sql) await sql`delete from crm_connections where workspace_id in (${workspaceId}, ${otherWorkspaceId})`;
    await app?.close();
    await sql?.end();
  });

  it("finds the workspace from the event's portal id and ignores a workspace id on the URL", async () => {
    const res = await deliver([{ eventId: `${stamp}1`, portalId: Number(PORTAL), subscriptionType: "contact.propertyChange", objectId: 1 }], `?workspaceId=${otherWorkspaceId}`);
    expect(res.statusCode).toBe(200);
    // The sync itself fails here (no real HubSpot), which is logged and does not fail the webhook.
    expect(res.json()).toMatchObject({ ok: true, events: 1, duplicates: 0, unmatched: 0 });
    const [seen] = await sql`select count(*)::int as n from cops_processed_events where consumer = 'hubspot-webhook' and event_id = ${hubspotEventKey(PORTAL, `${stamp}1`)}`;
    expect(seen.n).toBe(1);
  });

  it("an event delivered twice runs once, and an unknown portal reaches no workspace", async () => {
    const event = { eventId: `${stamp}2`, portalId: Number(PORTAL), subscriptionType: "deal.creation", objectId: 2 };
    expect((await deliver([event])).json()).toMatchObject({ duplicates: 0 });
    expect((await deliver([event])).json()).toMatchObject({ events: 1, duplicates: 1, synced: 0 });
    expect((await deliver([{ eventId: `${stamp}3`, portalId: 1, subscriptionType: "contact.creation", objectId: 3 }])).json()).toMatchObject({ unmatched: 1, synced: 0 });
  });

  it("refuses a bad signature, and accepts HubSpot's empty validation call", async () => {
    const body = JSON.stringify([{ eventId: 9, portalId: Number(PORTAL) }]);
    const bad = await app.inject({ method: "POST", url: "/api/v1/crm/hubspot/webhook", headers: { "content-type": "application/json", "x-hubspot-signature": v1("other") }, payload: body });
    expect(bad.statusCode).toBe(401);
    expect((await deliver([])).json()).toMatchObject({ ok: true, events: 0 });
  });

  it("records the real portal id for a connection made before the fix, once", async () => {
    await sql`update crm_connections set external_account_id = 'a1b2c3d4e5f6' where workspace_id = ${workspaceId} and provider = 'hubspot'`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hub_id: Number(PORTAL) }), { status: 200 })) as unknown as typeof fetch;
    expect(await ensureHubSpotPortalId(db, workspaceId, "token", fetchImpl)).toBe(PORTAL);
    const [row] = await sql`select external_account_id from crm_connections where workspace_id = ${workspaceId} and provider = 'hubspot'`;
    expect(row.external_account_id).toBe(PORTAL);
    // Already a real id: HubSpot is not asked again.
    expect(await ensureHubSpotPortalId(db, workspaceId, "token", fetchImpl)).toBe(PORTAL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
