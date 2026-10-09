import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-03 payment links against a real Postgres (COPS_TEST_DATABASE_URL). The Razorpay API is
 * stubbed at fetch; webhooks are signed with the configured secret exactly as Razorpay signs them.
 * Acceptance: no card data stored or logged; replayed webhook leaves state unchanged; bad signature -> 401.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (
  url: string,
  options?: object
) => any;

const OWNER = `payments-owner-${Date.now()}@example.test`;
const WEBHOOK_SECRET = "whsec_test_cops03";
const WEBHOOK = "/api/v1/billing/webhooks/razorpay/payment-links";
// Provider payment ids are globally unique at Razorpay; make them unique per run here too.
const RUN = Date.now().toString(36);

maybe("COPS-03 payment requests and webhook", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let opportunityId = "";
  const linkCalls: Array<Record<string, unknown>> = [];

  const call = (method: "GET" | "POST", path: string, body?: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": OWNER, ...(key && method === "POST" ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  const webhook = (body: object, opts: { eventId?: string; signature?: string | null } = {}) => {
    const raw = JSON.stringify(body);
    const signature = opts.signature === undefined ? createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex") : opts.signature;
    return app.inject({
      method: "POST",
      url: WEBHOOK,
      headers: {
        "content-type": "application/json",
        "x-razorpay-event-id": opts.eventId ?? `evt_${randomUUID()}`,
        ...(signature !== null ? { "x-razorpay-signature": signature } : {}),
      },
      payload: raw,
    });
  };

  // A card object of the kind Razorpay includes on a payment entity. None of it may be stored.
  const card = { id: "card_X", last4: "1111", network: "Visa", name: "Jane Buyer", number: "4111111111111111" };
  const paidEvent = (linkId: string, paymentId: string) => ({
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: linkId, status: "paid", amount: 50_000, amount_paid: 50_000, currency: "INR" } },
      payment: {
        entity: { id: paymentId, order_id: "order_1", status: "captured", amount: 50_000, currency: "INR", method: "card", card, email: "jane@buyer.test", contact: "+919999999999" },
      },
    },
  });

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === "https://api.razorpay.com/v1/payment_links") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        linkCalls.push(body);
        if (body.description === "FAIL") return new Response('{"error":{"code":"BAD_REQUEST_ERROR"}}', { status: 400 });
        const id = `plink_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
        return new Response(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}`, status: "created" }), { status: 200 });
      }
      return realFetch(input, init);
    });
    const config = loadEnv();
    app = await buildApp({
      ...config,
      DATABASE_URL: url,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
      RAZORPAY_KEY_ID: "rzp_test_key",
      RAZORPAY_KEY_SECRET: "rzp_test_secret",
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const [roles] = await sql`select count(*)::int as n from roles where key = 'owner'`;
    if (roles.n === 0) {
      const backfill = spawnSync("npx", ["tsx", "src/backfill-rbac.ts"], {
        cwd: new URL("../../../../packages/db/", import.meta.url),
        env: { ...process.env, DATABASE_URL: url },
        shell: true,
        encoding: "utf8",
      });
      if (backfill.status !== 0) throw new Error(`backfill-rbac failed: ${backfill.stderr}`);
    }
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'Payments test') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Commercial', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, pipeline_id, stage_id, name, currency) values (${workspaceId}, ${pipeline.id}, ${stage.id}, 'Payments deal', 'INR') returning id`;
    opportunityId = deal.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await sql?.end();
  });

  async function newRequest(amount = 50_000) {
    const res = await call("POST", "/payment-requests", { opportunity_id: opportunityId, amount_minor: amount, currency: "INR" });
    expect(res.statusCode).toBe(201);
    return res.json().data as { id: string; provider_ref: string; checkout_url: string; status: string };
  }

  it("creates a provider-hosted link, stores only refs, emits PaymentRequested and moves to payment_pending", async () => {
    const pr = await newRequest();
    expect(pr).toMatchObject({ status: "requested", provider: "razorpay", amount_minor: 50_000, currency: "INR" });
    expect(pr.checkout_url).toBe(`https://rzp.io/i/${pr.provider_ref}`);
    const sentToProvider = linkCalls.at(-1)!;
    expect(sentToProvider).toMatchObject({ amount: 50_000, currency: "INR", reference_id: pr.id, notify: { sms: false, email: false } });
    const [event] = await sql`select envelope from cops_outbox where tenant_id = ${workspaceId} and event_type = 'PaymentRequested' and aggregate_id = ${pr.id}`;
    expect(event.envelope.payload).toEqual({ payment_request_id: pr.id, opportunity_id: opportunityId });
    const [state] = await sql`select state from cops_lifecycle_states where workspace_id = ${workspaceId} and dimension = 'commercial' and entity_id = ${opportunityId}`;
    expect(state.state).toBe("payment_pending");
  });

  it("returns 502 retryable when the provider rejects, and 422 without an amount", async () => {
    const res = await call("POST", "/payment-requests", { opportunity_id: opportunityId, amount_minor: 50_000, description: "FAIL" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
    expect((await call("POST", "/payment-requests", { opportunity_id: opportunityId })).statusCode).toBe(422);
  });

  it("rejects a missing or bad signature with 401 and changes nothing", async () => {
    const pr = await newRequest();
    const body = paidEvent(pr.provider_ref, `pay_bad_${RUN}`);
    expect((await webhook(body, { signature: null })).statusCode).toBe(401);
    expect((await webhook(body, { signature: "0".repeat(64) })).statusCode).toBe(401);
    const tampered = await app.inject({
      method: "POST",
      url: WEBHOOK,
      headers: {
        "content-type": "application/json",
        "x-razorpay-event-id": "evt_tampered",
        "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(JSON.stringify(body)).digest("hex"),
      },
      payload: JSON.stringify({ ...body, event: "payment_link.paid " }),
    });
    expect(tampered.statusCode).toBe(401);
    const [row] = await sql`select status from payment_requests where id = ${pr.id}`;
    expect(row.status).toBe("requested");
  });

  it("paid webhook marks paid and emits PaymentSucceeded once; a replay is a no-op", async () => {
    const pr = await newRequest();
    const eventId = `evt_${randomUUID()}`;
    const first = await webhook(paidEvent(pr.provider_ref, `pay_1_${RUN}`), { eventId });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false, outcome: "applied", status: "paid" });

    const replay = await webhook(paidEvent(pr.provider_ref, `pay_1_${RUN}`), { eventId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true });

    const [row] = await sql`select status, provider_payment_id, paid_at from payment_requests where id = ${pr.id}`;
    expect(row).toMatchObject({ status: "paid", provider_payment_id: `pay_1_${RUN}` });
    const events = await sql`select 1 from cops_outbox where event_type = 'PaymentSucceeded' and aggregate_id = ${pr.id}`;
    expect(events).toHaveLength(1);
    const audits = await sql`select actor_type, actor_ref, source_channel from audit_logs where entity_id = ${pr.id} and action = 'payment_request.paid'`;
    expect(audits).toEqual([{ actor_type: "integration", actor_ref: "razorpay", source_channel: "webhook" }]);
  });

  it("stores no card or customer contact data from the webhook", async () => {
    const pr = await newRequest();
    await webhook(paidEvent(pr.provider_ref, `pay_3_${RUN}`));
    const [stored] = await sql`select refs from payment_provider_events where payment_request_id = ${pr.id}`;
    // Only these reconciliation keys are kept; anything else from the payload is dropped.
    expect(Object.keys(stored.refs).sort()).toEqual(
      ["amount", "currency", "event", "order_id", "payment_id", "payment_link_id", "payment_link_status", "refund_id"].sort()
    );
    const text = JSON.stringify(stored.refs);
    for (const secret of ["4111111111111111", "Visa", "Jane", "jane@buyer.test", "+919999999999", "last4"]) {
      expect(text).not.toContain(secret);
    }
    expect(stored.refs).toMatchObject({ payment_link_id: pr.provider_ref, payment_id: `pay_3_${RUN}`, amount: 50_000, currency: "INR" });
    const [requestRow] = await sql`select row_to_json(p)::text as json from payment_requests p where id = ${pr.id}`;
    expect(requestRow.json).not.toContain("4111111111111111");
  });

  it("status only moves forward: late failed after paid is ignored; refund after paid applies", async () => {
    const pr = await newRequest();
    await webhook(paidEvent(pr.provider_ref, `pay_2_${RUN}`));
    const late = await webhook({ event: "payment.failed", payload: { payment: { entity: { id: `pay_x_${RUN}`, notes: { payment_request_id: pr.id } } } } });
    expect(late.json()).toMatchObject({ outcome: "ignored", status: "paid" });
    const refund = await webhook({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: `pay_2_${RUN}`, amount: 50_000, currency: "INR" } } } });
    expect(refund.json()).toMatchObject({ outcome: "applied", status: "refunded" });
  });

  it("an event for an unknown link is recorded as unmatched", async () => {
    const res = await webhook(paidEvent("plink_unknown", `pay_unknown_${RUN}`));
    expect(res.json()).toMatchObject({ outcome: "unmatched" });
  });

  it("concurrent duplicate deliveries apply once", async () => {
    const pr = await newRequest();
    const eventId = `evt_${randomUUID()}`;
    const results = await Promise.all([1, 2, 3].map(() => webhook(paidEvent(pr.provider_ref, `pay_c_${RUN}`), { eventId })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().duplicate === false)).toHaveLength(1);
    const events = await sql`select 1 from cops_outbox where event_type = 'PaymentSucceeded' and aggregate_id = ${pr.id}`;
    expect(events).toHaveLength(1);
  });
});
