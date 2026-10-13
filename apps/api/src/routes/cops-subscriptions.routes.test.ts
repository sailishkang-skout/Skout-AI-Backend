import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { getAccountSubscription, runSubscriptionBilling } from "../services/cops-subscriptions.service.js";

/**
 * COPS-08 subscriptions against a real Postgres (COPS_TEST_DATABASE_URL): payment-link billing per
 * period, the failed-payment timeline counted from the bill's due date, automatic restore on
 * payment, invoiced accounts that are never suspended, and tenant isolation. The billing pass is
 * run with a chosen "now" so the timeline can be walked without waiting.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const stamp = Date.now();
const OWNER = `subs-owner-${stamp}@example.test`;
const OTHER = `subs-other-${stamp}@example.test`;
const DAY = 86_400_000;

maybe("COPS-08 subscriptions", () => {
  let app: FastifyInstance;
  let db: Db;
  let sql: any;
  let workspaceId = "";
  let pipelineId = "";
  let stageId = "";

  const call = (method: "GET" | "POST", path: string, body?: unknown, email = OWNER) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": email, ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  const newAccount = async (currency = "USD") => {
    const [company] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, ${"Subs Co " + randomUUID().slice(0, 8)}) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      values (${workspaceId}, ${company.id}, ${pipelineId}, ${stageId}, 'Subscription deal', 9480, ${currency}) returning id`;
    return { accountId: company.id as string, opportunityId: deal.id as string };
  };
  const subscribe = (accountId: string, opportunityId: string, over: Record<string, unknown> = {}) =>
    call("POST", `/accounts/${accountId}/subscription`, { opportunity_id: opportunityId, seats: 10, cadence: "monthly", term_months: 12, payment_terms_net_days: 0, ...over });
  const current = async (accountId: string) => (await call("GET", `/accounts/${accountId}/subscription`)).json().data;
  /** The scheduled pass, for this workspace only, as if it ran `days` after `from`. */
  const at = (from: string, days: number) => new Date(new Date(from).getTime() + days * DAY + 3_600_000);
  const billAt = (from: string, days: number) => runSubscriptionBilling(db, at(from, days), { workspaceId });
  /** The subscription as it reads on that simulated day (the API reads it as of the real clock). */
  const currentAt = async (accountId: string, from: string, days: number) => (await getAccountSubscription(db, workspaceId, accountId, at(from, days)))!;

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === "https://api.razorpay.com/v1/payment_links") {
        const id = `plink_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
        return new Response(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}`, status: "created" }), { status: 200 });
      }
      return realFetch(input, init);
    });
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_test_secret", RAZORPAY_WEBHOOK_SECRET: "whsec_test_subscriptions" } as typeof config);
    db = (app as unknown as { db: Db }).db;
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const [seeded] = await sql`select count(*)::int as n from roles where key = 'owner'`;
    if (seeded.n === 0) {
      const backfill = spawnSync("npx", ["tsx", "src/backfill-rbac.ts"], { cwd: new URL("../../../../packages/db/", import.meta.url), env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: "utf8" });
      if (backfill.status !== 0) throw new Error(`backfill-rbac failed: ${backfill.stderr}`);
    }
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    await call("GET", "/me", undefined, OTHER);
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'Subscriptions test') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Closed', 1) returning id`;
    pipelineId = pipeline.id;
    stageId = stage.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await sql?.end();
  });

  it("creates a subscription priced from the price book, with a bill for the first period", async () => {
    const { accountId, opportunityId } = await newAccount();
    const res = await subscribe(accountId, opportunityId, { payment_terms_net_days: 30 });
    expect(res.statusCode).toBe(201);
    const sub = res.json().data;
    // USD 79 a seat on annual billing, plus 20% for month to month.
    expect(sub).toMatchObject({ status: "active", billing: "payment_link", currency: "USD", cadence: "monthly", seats: 10, dunning: null });
    expect(sub.items[0]).toMatchObject({ kind: "seats", quantity: 10, unit_amount_minor: 9480 });
    expect(sub.invoices).toHaveLength(1);
    expect(sub.invoices[0]).toMatchObject({ amount_minor: 94_800, currency: "USD", status: "open", payment_request_id: null });
    expect(new Date(sub.renews_at).getUTCFullYear()).toBe(new Date(sub.term_start).getUTCFullYear() + 1);
    // One subscription per account.
    expect((await subscribe(accountId, opportunityId)).statusCode).toBe(409);
  });

  it("refuses an opportunity of another account, a currency with no price, and provider auto-debit", async () => {
    const a = await newAccount();
    const b = await newAccount();
    expect((await subscribe(a.accountId, b.opportunityId)).statusCode).toBe(422);
    const aud = await newAccount("AUD");
    expect((await subscribe(aud.accountId, aud.opportunityId)).statusCode).toBe(422);
    // A price given by hand is accepted in any currency; nothing is converted.
    expect((await subscribe(aud.accountId, aud.opportunityId, { seat_month_minor: 12_000 })).json().data).toMatchObject({ currency: "AUD" });
    expect((await subscribe(a.accountId, a.opportunityId, { billing: "provider" })).statusCode).toBe(409);
  });

  it("walks the failed-payment timeline from the due date, and a payment restores access", async () => {
    const { accountId, opportunityId } = await newAccount();
    const sub = (await subscribe(accountId, opportunityId)).json().data;
    const due = sub.invoices[0].due_at as string;
    const statusOn = async (days: number) => {
      await billAt(due, days);
      return (await current(accountId)).status as string;
    };
    expect(await statusOn(0)).toBe("past_due");
    expect(await statusOn(7)).toBe("past_due");
    expect(await statusOn(8)).toBe("restricted");
    expect(await statusOn(15)).toBe("suspended");

    const events = await sql`select envelope->'payload' as payload from cops_outbox where event_type = 'SubscriptionStatusChanged' and aggregate_id = ${sub.id} order by created_at`;
    expect(events.map((e: { payload: { from: string; to: string } }) => `${e.payload.from}>${e.payload.to}`)).toEqual(["active>past_due", "past_due>restricted", "restricted>suspended"]);
    expect(events[1].payload).toMatchObject({ account_id: accountId, day: 8 });

    // Finance sees it in the queue.
    const queue = (await call("GET", "/finance/failed-payments")).json().data as Array<{ id: string; status: string }>;
    expect(queue.find((q) => q.id === sub.id)).toMatchObject({ status: "suspended" });

    // A payment link for the bill, through the COPS-03 flow; asking again reuses the live link.
    const link = await call("POST", `/subscription-invoices/${sub.invoices[0].id}/payment-link`);
    expect(link.statusCode).toBe(201);
    expect(link.json().data.payment_request).toMatchObject({ amount_minor: 94_800, currency: "USD", status: "requested" });
    expect(link.json().data.payment_request.checkout_url).toContain("https://rzp.io/i/");
    const again = await call("POST", `/subscription-invoices/${sub.invoices[0].id}/payment-link`);
    expect(again.json().data.payment_request_id).toBe(link.json().data.payment_request_id);

    // What the payment webhook does when the customer pays the link.
    await sql`update payment_requests set status = 'paid', paid_at = now() where id = ${link.json().data.payment_request_id}`;
    const run = await billAt(due, 16);
    expect(run.status_changes.find((c) => c.subscription_id === sub.id)).toMatchObject({ from: "suspended", to: "active", day: null });
    const restored = await current(accountId);
    expect(restored).toMatchObject({ status: "active", dunning: null });
    expect(restored.invoices[0]).toMatchObject({ status: "paid" });
    // Nothing was deleted on the way.
    expect((await sql`select count(*)::int as n from subscription_invoices where subscription_id = ${sub.id}`)[0].n).toBe(1);
  });

  it("bills the next period when it starts, once, however often the pass runs", async () => {
    const { accountId, opportunityId } = await newAccount();
    const sub = (await subscribe(accountId, opportunityId)).json().data;
    await sql`update subscription_invoices set status = 'paid', paid_at = now() where subscription_id = ${sub.id}`;
    const due = sub.invoices[0].due_at as string;
    expect((await billAt(due, 20)).invoices_created).toBe(0);
    await billAt(due, 32);
    await billAt(due, 32);
    const after = await currentAt(accountId, due, 32);
    expect(after.invoices).toHaveLength(2);
    expect(after.invoices[0]).toMatchObject({ status: "open", amount_minor: 94_800 });
    // The second bill is now overdue by a day or two: day 0 is its own due date, not the first bill's.
    expect(after).toMatchObject({ status: "past_due" });
    expect(after.dunning!.day).toBeLessThan(3);
    expect(after.dunning).toMatchObject({ next_status: "restricted" });
  });

  it("closes on day 45, and a closed subscription is not reopened by a late payment", async () => {
    const { accountId, opportunityId } = await newAccount();
    const sub = (await subscribe(accountId, opportunityId, { cadence: "annual" })).json().data;
    // Annual billing: the first bill covers twelve months at the annual price.
    expect(sub.invoices[0]).toMatchObject({ amount_minor: 948_000 });
    await billAt(sub.invoices[0].due_at, 45);
    expect((await current(accountId)).status).toBe("closed");
    await sql`update subscription_invoices set status = 'paid', paid_at = now() where subscription_id = ${sub.id}`;
    await billAt(sub.invoices[0].due_at, 46);
    expect((await current(accountId)).status).toBe("closed");
    // The account can then take a new subscription.
    expect((await subscribe(accountId, opportunityId)).statusCode).toBe(201);
  });

  it("an invoiced account is never suspended automatically; Finance marks its bill paid with a reason", async () => {
    const { accountId, opportunityId } = await newAccount();
    const sub = (await subscribe(accountId, opportunityId, { billing: "invoiced" })).json().data;
    await billAt(sub.invoices[0].due_at, 30);
    const late = await currentAt(accountId, sub.invoices[0].due_at, 30);
    expect(late).toMatchObject({ status: "past_due" });
    expect(late.dunning).toMatchObject({ day: 30, next_status: null });

    expect((await call("POST", `/subscription-invoices/${sub.invoices[0].id}/mark-paid`, {})).statusCode).toBe(422);
    expect((await call("POST", `/subscription-invoices/${sub.invoices[0].id}/mark-paid`, { reason: "Wire received, ref 4471" })).statusCode).toBe(200);
    expect(await current(accountId)).toMatchObject({ status: "active", dunning: null });
    const [audit] = await sql`select reason from audit_logs where entity_id = ${sub.invoices[0].id} and action = 'subscription_invoice.marked_paid'`;
    expect(audit.reason).toBe("Wire received, ref 4471");
    expect((await call("POST", `/subscription-invoices/${sub.invoices[0].id}/mark-paid`, { reason: "again" })).statusCode).toBe(409);
  });

  it("another workspace cannot see or change a subscription", async () => {
    const { accountId, opportunityId } = await newAccount();
    const sub = (await subscribe(accountId, opportunityId)).json().data;
    expect((await call("GET", `/accounts/${accountId}/subscription`, undefined, OTHER)).json().data).toBeNull();
    expect((await call("POST", `/subscription-invoices/${sub.invoices[0].id}/mark-paid`, { reason: "x" }, OTHER)).statusCode).toBe(404);
    expect((await call("POST", `/accounts/${accountId}/subscription`, { opportunity_id: opportunityId, seats: 1, cadence: "monthly", term_months: 1 }, OTHER)).statusCode).toBe(404);
    expect((await call("GET", "/finance/failed-payments", undefined, OTHER)).json().data).toEqual([]);
  });
});
