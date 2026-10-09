import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import type { FastifyInstance } from "fastify";
import { createDb } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { startFollowUp } from "../services/cops-follow-up.service.js";
import { ensureActivationInstance } from "../services/cops-activation.service.js";
import { evaluateOnboarding } from "../services/cops-onboarding-signals.service.js";
import { projectCopsEventToTimelineRow } from "../services/cops-timeline.service.js";

/**
 * COPS-07 Phase 1 golden paths (Bible p.90), end to end through the HTTP API on a real Postgres:
 * free trial, paid deal, failed payment, stalled onboarding, ticket escalation.
 *
 * What is real: every route, the database, the outbox, the commercial gate, provisioning, the
 * credit ledger, the onboarding email (sent over SMTP to a catcher started by this test) and the
 * Razorpay webhook signature. What is stood in: the Razorpay API (stubbed at fetch) and the event
 * worker. Redis is not part of the test run, so the three consumers the worker would call
 * (activation instance, follow-up, timeline) are called here with the outbox event, as the worker does.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const RUN = Date.now().toString(36);
const OWNER = `golden-${RUN}@example.test`;
const WEBHOOK_SECRET = "whsec_golden_paths";

/** Accepts any SMTP login and message and records the recipients. Delivers nothing. */
function startMailCatcher(received: string[]): Promise<Server> {
  const server = createServer((socket) => {
    let inData = false;
    let login = 0;
    let buffer = "";
    const send = (line: string) => socket.write(line + "\r\n");
    send("220 catcher ESMTP");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            send("250 OK queued");
          }
          continue;
        }
        if (login > 0) {
          login = login === 1 ? 2 : 0;
          send(login === 2 ? "334 UGFzc3dvcmQ6" : "235 OK");
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
          send("250-catcher");
          send("250 AUTH PLAIN LOGIN");
        } else if (cmd.startsWith("AUTH PLAIN")) send("235 OK");
        else if (cmd.startsWith("AUTH LOGIN")) {
          login = 1;
          send("334 VXNlcm5hbWU6");
        } else if (cmd.startsWith("RCPT TO")) {
          received.push(line.slice(8).replace(/[<>]/g, "").trim());
          send("250 OK");
        } else if (cmd === "DATA") {
          inData = true;
          send("354 go");
        } else if (cmd === "QUIT") {
          send("221 bye");
          socket.end();
        } else send("250 OK");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

maybe("COPS-07 Phase 1 golden paths", () => {
  let app: FastifyInstance;
  let sql: any;
  let mail: Server;
  const { db, sql: dbSql } = createDb(url as string);
  const mailed: string[] = [];
  let workspaceId = "";
  let config: ReturnType<typeof loadEnv>;

  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": OWNER, ...(key && method !== "GET" ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  const webhook = (body: object) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/razorpay/payment-links",
      headers: { "content-type": "application/json", "x-razorpay-event-id": `evt_${randomUUID()}`, "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex") },
      payload: raw,
    });
  };
  const paid = (linkId: string) => ({
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: linkId, status: "paid", amount: 50_000, amount_paid: 50_000, currency: "INR" } },
      payment: { entity: { id: `pay_${randomUUID().slice(0, 8)}`, status: "captured", amount: 50_000, currency: "INR" } },
    },
  });

  /** An account with one opportunity whose deal type uses the given gate policy. */
  async function account(policy: string, label: string) {
    const dealType = `${label}-${RUN}`;
    const [co] = await sql`insert into companies (workspace_id, name, employee_count) values (${workspaceId}, ${"Golden " + label}, 50) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, ${"Golden " + label}) returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Commercial', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, currency) values (${workspaceId}, ${co.id}, ${pipeline.id}, ${stage.id}, ${label + " deal"}, 'INR') returning id`;
    expect((await call("PUT", "/commercial/gate-policies", { deal_type: dealType, policy })).statusCode).toBe(200);
    expect((await call("PUT", `/opportunities/${deal.id}/deal-type`, { deal_type: dealType })).statusCode).toBe(200);
    return { accountId: co.id as string, opportunityId: deal.id as string, admin: `admin-${label}-${RUN}@customer.test` };
  }

  const gate = async (opportunityId: string) => (await call("GET", `/opportunities/${opportunityId}/gate`)).json().data as { open: boolean; fired_at: string | null };
  const provision = (a: { accountId: string; opportunityId: string; admin: string }) => call("POST", `/accounts/${a.accountId}/provision`, { opportunity_id: a.opportunityId, admin_email: a.admin });
  const events = async (type: string, aggregateId: string) => await sql`select envelope from cops_outbox where tenant_id = ${workspaceId} and event_type = ${type} and aggregate_id = ${aggregateId} order by created_at`;

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    mail = await startMailCatcher(mailed);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === "https://api.razorpay.com/v1/payment_links") {
        const id = `plink_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
        return new Response(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}`, status: "created" }), { status: 200 });
      }
      return realFetch(input, init);
    });
    config = {
      ...loadEnv(),
      DATABASE_URL: url,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
      EMAIL_INTEL_SERVICE_URL: undefined,
      RESEND_API_KEY: undefined,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: (mail.address() as { port: number }).port,
      SMTP_USERNAME: "catcher",
      SMTP_PASSWORD: "catcher",
      RAZORPAY_KEY_ID: "rzp_test_key",
      RAZORPAY_KEY_SECRET: "rzp_test_secret",
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as ReturnType<typeof loadEnv>;
    app = await buildApp(config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    const rows = await sql`select provisioned_workspace_id as id from cops_provisionings where workspace_id = ${workspaceId} and provisioned_workspace_id is not null`;
    for (const r of rows) await sql`delete from workspaces where id = ${r.id}`;
    await app?.close();
    await sql?.end();
    await dbSql.end();
    await new Promise((resolve) => mail.close(resolve));
  });

  // Shared between the trial, stalled-onboarding and escalation paths: one customer, in order.
  let trial: { accountId: string; opportunityId: string; admin: string };

  it("free trial: approval opens the gate, the workspace is provisioned, the onboarding email goes out and a follow-up exists", async () => {
    trial = await account("trial_approval_only", "trial");
    expect((await provision(trial)).json().code).toBe("GATE_CLOSED");
    expect((await call("POST", `/opportunities/${trial.opportunityId}/gate/approve-trial`, { reason: "Pilot approved" })).statusCode).toBe(200);
    expect((await gate(trial.opportunityId)).fired_at).not.toBeNull();

    const provisioned = await provision(trial);
    expect(provisioned.statusCode).toBe(201);
    expect(provisioned.json().data).toMatchObject({ status: "succeeded", admin_invite: { email: trial.admin, email_sent: true } });
    expect(mailed).toContain(trial.admin);
    expect(await events("WorkspaceProvisioned", trial.accountId)).toHaveLength(1);
    const credits = (await call("GET", `/accounts/${trial.accountId}/credits`)).json().data;
    expect(credits.balance).toBeGreaterThan(0);
    await ensureActivationInstance(db, workspaceId, trial.accountId);

    const sent = await call("POST", `/accounts/${trial.accountId}/onboarding/send`, {});
    expect(sent.statusCode).toBe(201);
    expect(sent.json().data).toMatchObject({ status: "sent", to: trial.admin });
    const [welcome] = await events("WelcomeEmailSent", trial.accountId);
    expect(welcome).toBeDefined();

    // The onboarding email always creates a next action (master checklist).
    await startFollowUp(db, welcome.envelope, { config, scheduleFirstStep: async () => {} });
    const state = (await call("GET", `/accounts/${trial.accountId}/onboarding`)).json().data;
    expect(state.follow_up).not.toBeNull();
    expect(state.activation.activation_pct).toBe(0);
    // A second provision request for the same opportunity never creates a second workspace.
    const [n] = await sql`select count(*)::int as n from cops_provisionings where account_id = ${trial.accountId} and status = 'succeeded'`;
    await provision(trial);
    const [after] = await sql`select count(distinct provisioned_workspace_id)::int as n from cops_provisionings where account_id = ${trial.accountId}`;
    expect(n.n).toBe(1);
    expect(after.n).toBe(1);
  });

  it("paid deal: the payment webhook opens the gate once and the workspace is provisioned", async () => {
    const a = await account("payment", "paid");
    const request = await call("POST", "/payment-requests", { opportunity_id: a.opportunityId, amount_minor: 50_000, currency: "INR" });
    expect(request.statusCode).toBe(201);
    const pr = request.json().data as { id: string; provider_ref: string };
    expect((await gate(a.opportunityId)).fired_at).toBeNull();
    expect((await provision(a)).json().code).toBe("GATE_CLOSED");

    const event = paid(pr.provider_ref);
    expect((await webhook(event)).statusCode).toBe(200);
    expect((await webhook(event)).statusCode).toBe(200);
    expect((await call("GET", `/payment-requests/${pr.id}`)).json().data.status).toBe("paid");
    expect((await gate(a.opportunityId)).fired_at).not.toBeNull();
    expect(await events("PaymentSucceeded", pr.id)).toHaveLength(1);
    expect((await provision(a)).json().data.status).toBe("succeeded");
  });

  it("failed payment: nothing is provisioned; a later success provisions; a failure after that keeps the workspace", async () => {
    const a = await account("payment", "failed");
    const pr = (await call("POST", "/payment-requests", { opportunity_id: a.opportunityId, amount_minor: 50_000, currency: "INR" })).json().data as { id: string; provider_ref: string };
    const failed = { event: "payment.failed", payload: { payment: { entity: { id: `pay_f_${randomUUID().slice(0, 8)}`, notes: { payment_request_id: pr.id } } } } };
    expect((await webhook(failed)).statusCode).toBe(200);
    expect((await gate(a.opportunityId)).fired_at).toBeNull();
    expect((await provision(a)).json().code).toBe("GATE_CLOSED");
    const [none] = await sql`select count(*)::int as n from cops_provisionings where account_id = ${a.accountId}`;
    expect(none.n).toBe(0);

    expect((await webhook(paid(pr.provider_ref))).statusCode).toBe(200);
    const provisioned = (await provision(a)).json().data;
    expect(provisioned.status).toBe("succeeded");
    expect((await webhook(failed)).statusCode).toBe(200);
    const [still] = await sql`select status, provisioned_workspace_id from cops_provisionings where id = ${provisioned.id}`;
    expect(still.status).toBe("succeeded");
    const [ws] = await sql`select count(*)::int as n from workspaces where id = ${still.provisioned_workspace_id}`;
    expect(ws.n).toBe(1);
  });

  it("stalled onboarding: two days without a sign-in raise a blocker and a task for the rep", async () => {
    const [inst] = await sql`select id from cops_onboarding_instances where workspace_id = ${workspaceId} and account_id = ${trial.accountId}`;
    const twoDaysOn = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const result = await evaluateOnboarding(db, inst.id, { config }, { now: twoDaysOn, correlationId: randomUUID() });
    expect(result.fired.length).toBeGreaterThan(0);
    const state = (await call("GET", `/accounts/${trial.accountId}/onboarding`)).json().data;
    expect(state.blockers.length).toBeGreaterThan(0);
    const [signal] = await sql`select task_id from cops_onboarding_signals where instance_id = ${inst.id} limit 1`;
    expect(signal.task_id).not.toBeNull();
    // Evaluating again raises nothing new: one signal per trigger.
    const again = await evaluateOnboarding(db, inst.id, { config }, { now: twoDaysOn, correlationId: randomUUID() });
    expect(again.fired).toEqual([]);
    expect(state.activation.activated_at).toBeNull();
  });

  it("ticket escalation: a ticket from the blocker reaches the queue, escalates, and stays private where it must", async () => {
    const blocker = (await call("GET", `/accounts/${trial.accountId}/onboarding`)).json().data.blockers[0].kind as string;
    const prefill = (await call("GET", `/tickets/prefill?account_id=${trial.accountId}&blocker=${blocker}`)).json().data;
    expect(prefill).toMatchObject({ severity: "high", priority: "p2" });
    expect(prefill.diagnostics).toMatchObject({ blocker, activation_pct: 0 });

    const created = await call("POST", "/tickets", { account_id: trial.accountId, title: prefill.title, category: prefill.category, severity: prefill.severity, priority: prefill.priority, diagnostics: prefill.diagnostics });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    expect((await call("GET", "/tickets?open=true&severity=high")).json().data.map((t: { id: string }) => t.id)).toContain(id);

    await call("POST", `/tickets/${id}/comments`, { body: "Root cause: token refresh", visibility: "internal" });
    await call("POST", `/tickets/${id}/comments`, { body: "We are working on a fix", visibility: "customer" });
    const escalated = await call("POST", `/tickets/${id}/escalate`, { severity: "critical", reason: "Go-live blocked" });
    expect(escalated.json().summary).toEqual({ open_count: 1, max_severity: "critical" });

    const [event] = await events("TicketEscalated", id);
    expect(event.envelope.payload).toEqual({ ticket_id: id, account_id: trial.accountId, severity: "critical" });
    expect(await projectCopsEventToTimelineRow(db, event.envelope)).toBe(true);
    const timeline = (await call("GET", `/accounts/${trial.accountId}/timeline`)).json().data as Array<{ type: string }>;
    expect(timeline.map((t) => t.type)).toContain("ticket");

    const safe = (await call("GET", `/tickets/${id}/customer-view`)).json().data;
    expect(safe.updates.map((u: { body: string }) => u.body)).toEqual(["We are working on a fix"]);
    expect(JSON.stringify(safe)).not.toContain("token refresh");
    const audited = await sql`select action from audit_logs where workspace_id = ${workspaceId} and entity_id = ${id} order by created_at`;
    expect(audited.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["ticket.created", "ticket.escalated"]));
  });
});
