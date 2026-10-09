import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import {
  PROVISIONING_STEPS,
  ProvisioningError,
  retryProvisioning,
  startProvisioning,
  type ProvisionRequest,
  type ProvisioningContext,
  type ProvisioningStepName,
} from "./cops-provisioning.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-04 provisioning saga against a real Postgres (COPS_TEST_DATABASE_URL, migration 0112, system
 * roles from backfill-rbac). Acceptance: same key -> same result, no duplicate workspace/invite/wallet;
 * a failure injected at each step resumes cleanly; latency is measured against the 2-minute target.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-04 provisioning saga (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  const created: string[] = [];
  let ctx: ProvisioningContext;

  async function opportunity(opts: { fired?: boolean } = {}) {
    const [company] = await sql`insert into companies (workspace_id, name) values (${ctx.workspaceId}, ${"Acme " + randomUUID().slice(0, 6)}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ctx.workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Commercial', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${ctx.workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'Trial') returning id`;
    if (opts.fired !== false) {
      await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal.id}, ${ctx.workspaceId}, now(), 'trial_approval_only')`;
    }
    return { accountId: company.id as string, opportunityId: deal.id as string };
  }

  const request = (opportunityId: string, over: Partial<ProvisionRequest> = {}): ProvisionRequest => ({
    opportunity_id: opportunityId,
    admin_email: `admin-${randomUUID().slice(0, 6)}@customer.test`,
    plan: "trial",
    trial_days: 14,
    credits: 500,
    integrations: ["crm", "email"],
    ...over,
  });

  async function counts(workspaceId: string | null, provisioningId: string) {
    const [r] = await sql`select
      (select count(*)::int from workspaces where id = ${workspaceId}) as workspaces,
      (select count(*)::int from workspace_invites where workspace_id = ${workspaceId}) as invites,
      (select count(*)::int from credit_balances where workspace_id = ${workspaceId}) as wallets,
      (select coalesce(sum(amount), 0)::int from credit_transactions where workspace_id = ${workspaceId}) as credits,
      (select count(*)::int from cops_outbox where event_type = 'WorkspaceProvisioned' and envelope->'payload'->>'workspace_id' = ${workspaceId}::text) as provisioned_events,
      (select count(*)::int from cops_outbox where event_type = 'CreditsGranted' and envelope->'payload'->>'wallet_id' = ${workspaceId}::text) as credit_events,
      (select count(*)::int from cops_provisioning_steps where provisioning_id = ${provisioningId} and status = 'succeeded') as steps_done`;
    return r;
  }

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Skout ops', ${"ops-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`rep-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    created.push(ws.id);
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
    const [owner] = await sql`select count(*)::int as n from roles where workspace_id is null and key in ('owner', 'admin', 'member')`;
    if (owner.n < 3) throw new Error("System roles missing: run packages/db backfill-rbac against the test database");
  });

  afterAll(async () => {
    const provisioned = await sql`select provisioned_workspace_id from cops_provisionings where workspace_id = any(${created}) and provisioned_workspace_id is not null`;
    for (const id of [...provisioned.map((r: { provisioned_workspace_id: string }) => r.provisioned_workspace_id), ...created]) {
      await sql`delete from workspaces where id = ${id}`;
    }
    await sql.end();
    await dbSql.end();
  });

  it("provisions a real workspace with invite, entitlements, wallet and events, within the target", async () => {
    const { accountId, opportunityId } = await opportunity();
    const sent: string[] = [];
    const { provisioning, replayed } = await startProvisioning(db, ctx, accountId, "key-happy-0001", request(opportunityId), {
      inviteBaseUrl: "https://app.test",
      sendInvite: async ({ to }) => {
        sent.push(to);
        return { sent: true };
      },
    });
    expect(replayed).toBe(false);
    expect(provisioning.status).toBe("succeeded");
    expect(provisioning.steps.map((s) => [s.step, s.status])).toEqual(PROVISIONING_STEPS.map((s) => [s, "succeeded"]));
    expect(provisioning.within_target).toBe(true);
    expect(provisioning.duration_ms).toBeGreaterThanOrEqual(0);
    expect(provisioning.admin_invite?.accept_url).toMatch(/^https:\/\/app\.test\/invite\/[a-f0-9]{64}$/);
    expect(sent).toEqual([provisioning.admin_invite?.email]);

    const ws = provisioning.provisioned_workspace_id!;
    expect(await counts(ws, provisioning.id)).toMatchObject({ workspaces: 1, invites: 1, wallets: 1, credits: 500, provisioned_events: 1, credit_events: 1, steps_done: 7 });
    const [invite] = await sql`select role, email from workspace_invites where workspace_id = ${ws}`;
    expect(invite.role).toBe("owner");
    const ent = await sql`select key, value from entitlements where workspace_id = ${ws} order by key`;
    expect(ent.map((e: { key: string }) => e.key)).toEqual(["integrations", "plan", "trial"]);
    const [grant] = await sql`select kind, actor_type, actor_id, reason from credit_transactions where workspace_id = ${ws}`;
    expect(grant).toMatchObject({ kind: "grant", actor_type: "user", actor_id: ctx.userId });
    expect(grant.reason).toMatch(/Trial credits/);
    const [life] = await sql`select state from cops_lifecycle_states where workspace_id = ${ctx.workspaceId} and dimension = 'account' and entity_id = ${accountId}`;
    expect(life.state).toBe("trial");
    const audit = await sql`select action from audit_logs where workspace_id = ${ctx.workspaceId} and entity_id = ${accountId} order by created_at`;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(["provisioning.requested", "provisioning.succeeded"]);
  });

  it("the same key returns the same result and creates nothing new; a different body for that key is refused", async () => {
    const { accountId, opportunityId } = await opportunity();
    const body = request(opportunityId);
    const first = await startProvisioning(db, ctx, accountId, "key-replay-0001", body);
    const again = await Promise.all([
      startProvisioning(db, ctx, accountId, "key-replay-0001", body),
      startProvisioning(db, ctx, accountId, "key-replay-0001", { ...body, admin_email: body.admin_email.toUpperCase() }),
    ]);
    expect(again.every((r) => r.replayed && r.provisioning.id === first.provisioning.id)).toBe(true);
    expect(again[0]!.provisioning.provisioned_workspace_id).toBe(first.provisioning.provisioned_workspace_id);
    expect(await counts(first.provisioning.provisioned_workspace_id, first.provisioning.id)).toMatchObject({
      workspaces: 1,
      invites: 1,
      wallets: 1,
      credits: 500,
      provisioned_events: 1,
      credit_events: 1,
    });
    await expect(startProvisioning(db, ctx, accountId, "key-replay-0001", { ...body, credits: 9000 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("a second key for an account that already has a workspace is refused (no second workspace)", async () => {
    const { accountId, opportunityId } = await opportunity();
    const first = await startProvisioning(db, ctx, accountId, "key-second-0001", request(opportunityId));
    const error = await startProvisioning(db, ctx, accountId, "key-second-0002", request(opportunityId)).catch((e) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error).toMatchObject({ code: "ALREADY_PROVISIONED", status: 409, details: { provisioning_id: first.provisioning.id } });
    const [n] = await sql`select count(*)::int as n from cops_provisionings where account_id = ${accountId}`;
    expect(n.n).toBe(1);
  });

  it("refuses when the commercial gate has not fired, or the opportunity is another account's", async () => {
    const closed = await opportunity({ fired: false });
    await expect(startProvisioning(db, ctx, closed.accountId, "key-gate-00001", request(closed.opportunityId))).rejects.toMatchObject({
      code: "GATE_CLOSED",
      status: 409,
    });
    const other = await opportunity();
    await expect(startProvisioning(db, ctx, closed.accountId, "key-gate-00002", request(other.opportunityId))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const [n] = await sql`select count(*)::int as n from cops_provisionings where account_id = ${closed.accountId}`;
    expect(n.n).toBe(0);
  });

  for (const failing of PROVISIONING_STEPS) {
    it(`a failure injected at ${failing} rolls that step back and a retry resumes cleanly`, async () => {
      const { accountId, opportunityId } = await opportunity();
      let fail = true;
      const deps = {
        sendInvite: async () => ({ sent: true }),
        injectFailure: (step: ProvisioningStepName) => {
          if (fail && step === failing) throw new Error(`injected failure at ${step}`);
        },
      };
      const firstRun = await startProvisioning(db, ctx, accountId, `key-fail-${failing}`, request(opportunityId), deps);
      expect(firstRun.provisioning.status).toBe("failed");
      expect(firstRun.provisioning.last_error).toBe(`${failing}: injected failure at ${failing}`);
      const index = PROVISIONING_STEPS.indexOf(failing);
      expect(firstRun.provisioning.steps.map((s) => s.status)).toEqual(
        PROVISIONING_STEPS.map((_, i) => (i < index ? "succeeded" : i === index ? "failed" : "pending"))
      );
      const wsAfterFailure = firstRun.provisioning.provisioned_workspace_id;
      // The failed step left nothing behind (its transaction rolled back).
      if (failing === "create_workspace") expect(wsAfterFailure).toBeNull();
      if (failing === "admin_invite") expect((await counts(wsAfterFailure, firstRun.provisioning.id)).invites).toBe(0);
      if (failing === "credit_wallet") expect((await counts(wsAfterFailure, firstRun.provisioning.id)).credits).toBe(0);

      fail = false;
      const resumed = await retryProvisioning(db, { ...ctx, requestId: randomUUID() }, firstRun.provisioning.id, deps);
      expect(resumed.status).toBe("succeeded");
      expect(resumed.attempts).toBe(2);
      const failedStep = resumed.steps.find((s) => s.step === failing)!;
      expect(failedStep).toMatchObject({ status: "succeeded", attempts: 2, error: null });
      // Steps before the failure ran once; nothing ran twice.
      for (const s of resumed.steps.slice(0, index)) expect(s.attempts).toBe(1);
      if (wsAfterFailure) expect(resumed.provisioned_workspace_id).toBe(wsAfterFailure);
      expect(await counts(resumed.provisioned_workspace_id, resumed.id)).toMatchObject({
        workspaces: 1,
        invites: 1,
        wallets: 1,
        credits: 500,
        provisioned_events: 1,
        credit_events: 1,
        steps_done: 7,
      });
      const audit = await sql`select action from audit_logs where workspace_id = ${ctx.workspaceId} and entity_id = ${accountId} order by created_at`;
      expect(audit.map((a: { action: string }) => a.action)).toEqual([
        "provisioning.requested",
        "provisioning.failed",
        "provisioning.retried",
        "provisioning.succeeded",
      ]);
      await expect(retryProvisioning(db, ctx, resumed.id, deps)).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    });
  }

  it("the same key after a failure resumes the saga instead of starting a new one", async () => {
    const { accountId, opportunityId } = await opportunity();
    const body = request(opportunityId);
    let fail = true;
    const deps = { injectFailure: (step: ProvisioningStepName) => { if (fail && step === "entitlements") throw new Error("down"); } };
    const failed = await startProvisioning(db, ctx, accountId, "key-resume-0001", body, deps);
    expect(failed.provisioning.status).toBe("failed");
    fail = false;
    const resumed = await startProvisioning(db, ctx, accountId, "key-resume-0001", body, deps);
    expect(resumed).toMatchObject({ replayed: true, provisioning: { id: failed.provisioning.id, status: "succeeded" } });
  });

  it("an invite email failure does not fail provisioning", async () => {
    const { accountId, opportunityId } = await opportunity();
    const { provisioning } = await startProvisioning(db, ctx, accountId, "key-mail-00001", request(opportunityId), {
      sendInvite: async () => {
        throw new Error("SMTP down");
      },
    });
    expect(provisioning.status).toBe("succeeded");
    const [step] = await sql`select result from cops_provisioning_steps where provisioning_id = ${provisioning.id} and step = 'admin_invite'`;
    expect(step.result).toMatchObject({ email_sent: false, email_error: "send_failed" });
    // The API says so, so the UI does not claim the invitation was sent.
    expect(provisioning.admin_invite).toMatchObject({ email_sent: false });
  });

  it("zero trial credits still creates the wallet, with no ledger row and no CreditsGranted", async () => {
    const { accountId, opportunityId } = await opportunity();
    const { provisioning } = await startProvisioning(db, ctx, accountId, "key-zero-00001", request(opportunityId, { credits: 0 }));
    expect(await counts(provisioning.provisioned_workspace_id, provisioning.id)).toMatchObject({ wallets: 1, credits: 0, credit_events: 0 });
  });
});
