import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@skout/db";
import { startProvisioning, type ProvisioningContext } from "./cops-provisioning.service.js";
import { applyPaidCreditPurchases, extendTrial, getWallet, postManualCredit, WalletError } from "./cops-credits.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-04 wallet against a real Postgres: manual grants/adjustments need a reason, are audited and
 * idempotent; corrections are compensating entries; purchases only from paid payment requests,
 * once; trial extension is audited.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-04 credit wallet (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: ProvisioningContext;

  async function provisionedAccount(credits = 500) {
    const [company] = await sql`insert into companies (workspace_id, name) values (${ctx.workspaceId}, ${"Wallet " + randomUUID().slice(0, 6)}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ctx.workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'S', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${ctx.workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'D') returning id`;
    await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal.id}, ${ctx.workspaceId}, now(), 'payment')`;
    return { accountId: company.id as string, opportunityId: deal.id as string, credits };
  }
  async function provision(a: { accountId: string; opportunityId: string; credits: number }) {
    const { provisioning } = await startProvisioning(db, ctx, a.accountId, `key-${randomUUID()}`, {
      opportunity_id: a.opportunityId,
      admin_email: `a-${randomUUID().slice(0, 6)}@c.test`,
      plan: "trial",
      trial_days: 14,
      credits: a.credits,
      integrations: ["crm"],
    });
    expect(provisioning.status).toBe("succeeded");
    return provisioning.provisioned_workspace_id!;
  }
  async function paidCreditsRequest(opportunityId: string, credits: number, status = "paid") {
    const [proposal] = await sql`insert into proposals (workspace_id, opportunity_id, title, status) values (${ctx.workspaceId}, ${opportunityId}, 'Credits', 'sent') returning id`;
    const [version] = await sql`insert into proposal_versions (workspace_id, proposal_id, version, currency, billing_cadence, term_months, subtotal_minor, discount_minor, tax_minor, total_minor)
      values (${ctx.workspaceId}, ${proposal.id}, 1, 'INR', 'one_time', 1, 1000, 0, 0, 1000) returning id`;
    await sql`insert into proposal_line_items (workspace_id, version_id, position, kind, description, quantity, unit_amount_minor, gross_minor, discount_minor, net_minor)
      values (${ctx.workspaceId}, ${version.id}, 1, 'credits', 'Credit pack', ${credits}, 1, ${credits}, 0, ${credits}),
             (${ctx.workspaceId}, ${version.id}, 2, 'fee', 'Setup', 1, 100, 100, 0, 100)`;
    const [pr] = await sql`insert into payment_requests (workspace_id, opportunity_id, proposal_id, amount_minor, currency, status, provider, provider_ref, checkout_url)
      values (${ctx.workspaceId}, ${opportunityId}, ${proposal.id}, 1000, 'INR', ${status}, 'razorpay', ${"plink_" + randomUUID()}, 'https://rzp.test') returning id`;
    return pr.id as string;
  }
  const wctx = () => ({ ...ctx, requestId: randomUUID() });

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Wallet ops', ${"wops-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`fin-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
  });

  afterAll(async () => {
    const provisioned = await sql`select provisioned_workspace_id as id from cops_provisionings where workspace_id = ${ctx.workspaceId} and provisioned_workspace_id is not null`;
    for (const r of provisioned) await sql`delete from workspaces where id = ${r.id}`;
    await sql`delete from workspaces where id = ${ctx.workspaceId}`;
    await sql.end();
    await dbSql.end();
  });

  it("a wallet is only readable once the account is provisioned", async () => {
    const a = await provisionedAccount();
    await expect(getWallet(db, ctx.workspaceId, a.accountId)).rejects.toMatchObject({ code: "NOT_PROVISIONED", status: 404 });
    const ws = await provision(a);
    const wallet = await getWallet(db, ctx.workspaceId, a.accountId);
    expect(wallet).toMatchObject({ workspace_id: ws, balance: 500 });
    expect(wallet.ledger.map((e) => [e.kind, e.amount])).toEqual([["grant", 500]]);
  });

  it("a complimentary grant records who and why, emits CreditsGranted, and a duplicate submit applies once", async () => {
    const a = await provisionedAccount();
    const ws = await provision(a);
    const input = { kind: "grant" as const, amount: 250, reason: "Pilot extension agreed with CFO", requestKey: "grant-dup-0001" };
    const results = await Promise.all([postManualCredit(db, wctx(), a.accountId, input), postManualCredit(db, wctx(), a.accountId, input)]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await getWallet(db, ctx.workspaceId, a.accountId)).balance).toBe(750);
    const [row] = await sql`select actor_type, actor_id, reason from credit_transactions where workspace_id = ${ws} and kind = 'grant' and action = 'complimentary_grant'`;
    expect(row).toEqual({ actor_type: "user", actor_id: ctx.userId, reason: input.reason });
    const [audit] = await sql`select count(*)::int as n from audit_logs where entity_id = ${ws} and action = 'credits.granted' and reason = ${input.reason}`;
    expect(audit.n).toBe(1);
    const [events] = await sql`select count(*)::int as n from cops_outbox where event_type = 'CreditsGranted' and envelope->'payload'->>'wallet_id' = ${ws}::text and (envelope->'payload'->>'amount')::int = 250`;
    expect(events.n).toBe(1);
  });

  it("an adjustment can correct an earlier entry, cannot take the balance below zero, and is an audited override", async () => {
    const a = await provisionedAccount(100);
    const ws = await provision(a);
    const wrong = await postManualCredit(db, wctx(), a.accountId, { kind: "grant", amount: 1000, reason: "Typo, meant 10", requestKey: "grant-typo-0001" });
    const fix = await postManualCredit(db, wctx(), a.accountId, {
      kind: "adjustment",
      amount: -990,
      reason: "Correct the 1000 grant to 10",
      compensatesId: wrong.entry.id,
      requestKey: "adj-fix-00001",
    });
    expect(fix).toMatchObject({ balance: 110, entry: { kind: "adjustment", compensates_id: wrong.entry.id } });
    await expect(
      postManualCredit(db, wctx(), a.accountId, { kind: "adjustment", amount: -5000, reason: "Too much", requestKey: "adj-neg-00001" })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS", status: 409 });
    const err = await postManualCredit(db, wctx(), a.accountId, {
      kind: "adjustment",
      amount: 5,
      reason: "x",
      compensatesId: randomUUID(),
      requestKey: "adj-bad-00001",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect(err.details.fields[0].path).toBe("compensates_id");
    const [audit] = await sql`select is_override, reason from audit_logs where entity_id = ${ws} and action = 'credits.adjusted'`;
    expect(audit).toEqual({ is_override: true, reason: "Correct the 1000 grant to 10" });
  });

  it("purchases land only for paid payment requests, once, including payments made before provisioning", async () => {
    const a = await provisionedAccount(0);
    await paidCreditsRequest(a.opportunityId, 300, "paid");
    await paidCreditsRequest(a.opportunityId, 999, "requested");
    const ws = await provision(a); // applies the payment made before the workspace existed
    expect((await getWallet(db, ctx.workspaceId, a.accountId)).balance).toBe(300);

    const later = await paidCreditsRequest(a.opportunityId, 200, "paid");
    const again = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const first = await applyPaidCreditPurchases(t, { operatorWorkspaceId: ctx.workspaceId, accountId: a.accountId, requestId: randomUUID() });
      const second = await applyPaidCreditPurchases(t, { operatorWorkspaceId: ctx.workspaceId, accountId: a.accountId, requestId: randomUUID() });
      return [first, second];
    });
    expect(again).toEqual([200, 0]);
    const rows = await sql`select kind, amount, reference_id, actor_type from credit_transactions where workspace_id = ${ws} order by seq`;
    expect(rows.map((r: { kind: string; amount: number }) => [r.kind, r.amount])).toEqual([["purchase", 300], ["purchase", 200]]);
    expect(rows[1].reference_id).toBe(later);
  });

  it("extending the trial needs a reason, is audited, and updates the trial entitlement", async () => {
    const a = await provisionedAccount();
    const ws = await provision(a);
    const before = await getWallet(db, ctx.workspaceId, a.accountId);
    const out = await extendTrial(db, wctx(), a.accountId, { days: 7, reason: "Waiting on security review" });
    expect(new Date(out.trial_ends_at).getTime() - new Date(before.trial_ends_at!).getTime()).toBe(7 * 86_400_000);
    const [ent] = await sql`select value from entitlements where workspace_id = ${ws} and key = 'trial'`;
    expect(ent.value.ends_at).toBe(out.trial_ends_at);
    const [audit] = await sql`select reason from audit_logs where entity_id = ${a.accountId} and action = 'trial.extended'`;
    expect(audit.reason).toBe("Waiting on security review");
  });

  it("usage reports consumed credits per day for the last 30 days", async () => {
    const a = await provisionedAccount(100);
    const ws = await provision(a);
    const { postCreditTransaction } = await import("@skout/db");
    await postCreditTransaction(db, { workspaceId: ws, amount: -7, kind: "consume", action: "search" });
    await postCreditTransaction(db, { workspaceId: ws, amount: -3, kind: "consume", action: "enrich" });
    const wallet = await getWallet(db, ctx.workspaceId, a.accountId);
    expect(wallet.usage).toEqual([{ day: new Date().toISOString().slice(0, 10), consumed: 10 }]);
    const firstPage = await getWallet(db, ctx.workspaceId, a.accountId, { limit: 2 });
    expect(firstPage.ledger).toHaveLength(2);
    const secondPage = await getWallet(db, ctx.workspaceId, a.accountId, { limit: 2, cursor: firstPage.next_cursor! });
    expect(secondPage.ledger.map((e) => e.kind)).toEqual(["grant"]);
    expect(secondPage.next_cursor).toBeNull();
  });
});
