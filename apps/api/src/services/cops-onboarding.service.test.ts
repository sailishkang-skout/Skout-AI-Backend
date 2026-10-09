import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { startProvisioning, type ProvisioningContext } from "./cops-provisioning.service.js";
import { OnboardingError, previewOnboardingEmail, sendOnboardingEmail, type OnboardingDeps } from "./cops-onboarding.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-05 onboarding email against a real Postgres: sent once per key (double click included),
 * second send only as an audited re-send with a reason, canContact() refusals never send, a provider
 * failure is retryable on the same row, and a sent email emits exactly one WelcomeEmailSent.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-05 onboarding email (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: ProvisioningContext;
  const send = vi.fn(async (_mail: { to: string; subject: string; html: string }) => ({ sent: true, messageId: `msg-${randomUUID()}` }));
  const deps: OnboardingDeps = {
    config: { EMAIL_INTEL_SERVICE_URL: undefined, EMAIL_INTEL_TIMEOUT_MS: 1000 } as never,
    send: send as never,
    appBaseUrl: "https://app.skout.test",
    inviteBaseUrl: "https://app.skout.test",
    resourcesUrl: "https://app.skout.test/guides",
    supportEmail: "support@skout.test",
  };

  async function provisionedAccount(adminEmail = `admin-${randomUUID().slice(0, 6)}@customer.test`) {
    const [company] = await sql`insert into companies (workspace_id, name) values (${ctx.workspaceId}, ${"Onb " + randomUUID().slice(0, 6)}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ctx.workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'S', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${ctx.workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'D') returning id`;
    await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal.id}, ${ctx.workspaceId}, now(), 'trial_approval_only')`;
    await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${ctx.workspaceId}, ${company.id}, 'Ada', ${adminEmail})`;
    const { provisioning } = await startProvisioning(db, ctx, company.id, `key-${randomUUID()}`, {
      opportunity_id: deal.id,
      admin_email: adminEmail,
      plan: "trial",
      trial_days: 14,
      credits: 100,
      integrations: ["crm"],
    });
    expect(provisioning.status).toBe("succeeded");
    return { accountId: company.id as string, adminEmail };
  }

  const welcomeEvents = async (accountId: string) =>
    (await sql`select count(*)::int as n from cops_outbox where event_type = 'WelcomeEmailSent' and aggregate_id = ${accountId}`)[0].n as number;

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Onboarding ops', ${"oops-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`rep-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("refuses an account that has no provisioned workspace", async () => {
    const [co] = await sql`insert into companies (workspace_id, name) values (${ctx.workspaceId}, 'Not provisioned') returning id`;
    await expect(sendOnboardingEmail(db, ctx, co.id, randomUUID(), {}, deps)).rejects.toMatchObject({ code: "NOT_PROVISIONED", status: 404 });
  });

  it("previews the trial template with the workspace link and activation steps, without sending", async () => {
    const a = await provisionedAccount();
    send.mockClear();
    const p = await previewOnboardingEmail(db, ctx, a.accountId, { booking_url: "https://cal.test/skout" }, deps);
    expect(p).toMatchObject({ template_key: "welcome_trial", template_version: 1, to: a.adminEmail, blocked: null });
    expect(p.html).toContain("https://app.skout.test/invite/");
    expect(p.text).toContain("CRM connected");
    expect(p.text).toContain("https://cal.test/skout");
    expect(send).not.toHaveBeenCalled();
  });

  it("chooses the template by trial type and segment: an enterprise trial gets the enterprise welcome", async () => {
    const a = await provisionedAccount();
    await sql`update companies set employee_count = 2500 where id = ${a.accountId}`;
    const p = await previewOnboardingEmail(db, ctx, a.accountId, {}, deps);
    expect(p.template_key).toBe("welcome_trial_enterprise");
    expect(p.text).toContain("schedule a kickoff");
  });

  it("sends once per key: a replay and a concurrent double click send nothing more; one WelcomeEmailSent", async () => {
    const a = await provisionedAccount();
    send.mockClear();
    const key = randomUUID();
    const [r1, r2] = await Promise.all([
      sendOnboardingEmail(db, ctx, a.accountId, key, {}, deps),
      sendOnboardingEmail(db, ctx, a.accountId, key, {}, deps),
    ]);
    const r3 = await sendOnboardingEmail(db, ctx, a.accountId, key, {}, deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect(new Set([r1.send.id, r2.send.id, r3.send.id]).size).toBe(1);
    expect(r3).toMatchObject({ replayed: true, send: { status: "sent", to: a.adminEmail, is_resend: false } });
    expect(await welcomeEvents(a.accountId)).toBe(1);
    const [audit] = await sql`select action from audit_logs where entity_id = ${r1.send.id}`;
    expect(audit.action).toBe("onboarding_email.sent");
  });

  it("a second send needs resend with a reason, and the re-send is audited as an override", async () => {
    const a = await provisionedAccount();
    await sendOnboardingEmail(db, ctx, a.accountId, randomUUID(), {}, deps);
    await expect(sendOnboardingEmail(db, ctx, a.accountId, randomUUID(), {}, deps)).rejects.toMatchObject({ code: "ALREADY_SENT", status: 409 });
    await expect(sendOnboardingEmail(db, ctx, a.accountId, randomUUID(), { resend: true }, deps)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const again = await sendOnboardingEmail(db, ctx, a.accountId, randomUUID(), { resend: true, reason: "Customer lost the first email" }, deps);
    expect(again.send).toMatchObject({ is_resend: true, reason: "Customer lost the first email", status: "sent" });
    const [audit] = await sql`select action, reason, is_override from audit_logs where entity_id = ${again.send.id}`;
    expect(audit).toMatchObject({ action: "onboarding_email.resent", reason: "Customer lost the first email", is_override: true });
    expect(await welcomeEvents(a.accountId)).toBe(2);
  });

  it("never emails a suppressed or hard-bounced recipient", async () => {
    const a = await provisionedAccount();
    await sql`insert into suppressions (workspace_id, email) values (${ctx.workspaceId}, ${a.adminEmail})`;
    send.mockClear();
    await expect(sendOnboardingEmail(db, ctx, a.accountId, randomUUID(), {}, deps)).rejects.toMatchObject({ code: "CONTACT_BLOCKED", details: { reason: "suppressed" } });
    expect(send).not.toHaveBeenCalled();
    const [rows] = await sql`select count(*)::int as n from cops_onboarding_email_sends where account_id = ${a.accountId}`;
    expect(rows.n).toBe(0);
    expect(await welcomeEvents(a.accountId)).toBe(0);
    expect((await previewOnboardingEmail(db, ctx, a.accountId, {}, deps)).blocked).toBe("suppressed");
  });

  it("a provider failure is retryable: the same key tries again on the same row", async () => {
    const a = await provisionedAccount();
    const key = randomUUID();
    send.mockRejectedValueOnce(new Error("Resend 503"));
    const err = await sendOnboardingEmail(db, ctx, a.accountId, key, {}, deps).catch((e) => e);
    expect(err).toBeInstanceOf(OnboardingError);
    expect(err).toMatchObject({ code: "EMAIL_NOT_SENT", status: 502, retryable: true });
    expect(await welcomeEvents(a.accountId)).toBe(0);
    const ok = await sendOnboardingEmail(db, ctx, a.accountId, key, {}, deps);
    expect(ok.send.id).toBe(err.details.email_send_id);
    expect(ok.send.status).toBe("sent");
    expect(await welcomeEvents(a.accountId)).toBe(1);
  });

  it("a failed first send can be sent again with a new key (reopened dialog), without a re-send reason", async () => {
    const a = await provisionedAccount();
    send.mockRejectedValueOnce(new Error("535 Authentication Credentials Invalid"));
    const failed = await sendOnboardingEmail(db, ctx, a.accountId, randomUUID(), {}, deps).catch((e) => e);
    expect(failed).toMatchObject({ code: "EMAIL_NOT_SENT" });
    const newKey = randomUUID();
    const ok = await sendOnboardingEmail(db, ctx, a.accountId, newKey, {}, deps);
    expect(ok.send).toMatchObject({ id: failed.details.email_send_id, status: "sent", is_resend: false });
    // The new key now owns the row: a double click replays it, and a third key is a real "already sent".
    expect(await sendOnboardingEmail(db, ctx, a.accountId, newKey, {}, deps)).toMatchObject({ replayed: true });
    await expect(sendOnboardingEmail(db, ctx, a.accountId, randomUUID(), {}, deps)).rejects.toMatchObject({ code: "ALREADY_SENT" });
    expect(await welcomeEvents(a.accountId)).toBe(1);
    const [rows] = await sql`select count(*)::int as n from cops_onboarding_email_sends where account_id = ${a.accountId}`;
    expect(rows.n).toBe(1);
  });
});
