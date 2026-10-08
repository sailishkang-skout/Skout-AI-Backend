import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { FOLLOW_UP_SEQUENCE_TEMPLATE_KEY, startFollowUp, type FollowUpDeps } from "./cops-follow-up.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-05 acceptance "100% of WelcomeEmailSent events yield an enrollment or a task" against a real
 * Postgres: the configured sequence when possible, a task with the reason otherwise, a redelivered
 * event creates nothing new, and each outcome emits its event (SequenceEnrolled / TaskCreated).
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-05 follow-up after WelcomeEmailSent (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws = "";
  let ownerId = "";
  const scheduleFirstStep = vi.fn(async () => {});
  const deps: FollowUpDeps = { config: { EMAIL_INTEL_SERVICE_URL: undefined, EMAIL_INTEL_TIMEOUT_MS: 1000 } as never, scheduleFirstStep };

  /** An account with a contact (optionally linked to a prospect) and a sent onboarding email. */
  async function sentWelcome(opts: { prospect?: boolean; contact?: boolean } = {}) {
    const stamp = randomUUID().slice(0, 8);
    const email = `cust-${stamp}@customer.test`;
    const [co] = await sql`insert into companies (workspace_id, name, owner_id) values (${ws}, ${"FU " + stamp}, ${ownerId}) returning id`;
    let contactId: string | null = null;
    let prospectId: string | null = null;
    if (opts.contact !== false) {
      prospectId = opts.prospect ? `prospect-${stamp}` : null;
      [{ id: contactId }] = await sql`insert into contacts (workspace_id, company_id, first_name, email, source_prospect_id) values (${ws}, ${co.id}, 'Ada', ${email}, ${prospectId}) returning id`;
    }
    const [send] = await sql`insert into cops_onboarding_email_sends (workspace_id, account_id, contact_id, to_email, template_key, template_version, subject, idempotency_key, status, sent_at)
      values (${ws}, ${co.id}, ${contactId}, ${email}, 'welcome_trial', 1, 'Welcome', ${"k-" + stamp}, 'sent', now()) returning id`;
    return {
      accountId: co.id as string,
      email,
      prospectId,
      event: { event_id: randomUUID(), tenant_id: ws, correlation_id: randomUUID(), payload: { account_id: co.id as string, email_send_id: send.id as string } },
    };
  }

  async function configureSequence() {
    const [seq] = await sql`insert into sequences (workspace_id, name, status, template_key, current_version) values (${ws}, 'Onboarding follow-up', 'active', ${FOLLOW_UP_SEQUENCE_TEMPLATE_KEY}, 1) returning id`;
    await sql`insert into sequence_steps (sequence_id, step_order, step_type, delay_days, subject, body_template) values (${seq.id}, 1, 'task', 1, 'Verify access', 'Check the customer logged in')`;
    await sql`insert into sequence_versions (sequence_id, version, snapshot) values (${seq.id}, 1, '{}'::jsonb)`;
    return seq.id as string;
  }

  const eventsFor = async (accountId: string, type: string) =>
    (await sql`select count(*)::int as n from cops_outbox where event_type = ${type} and aggregate_id = ${accountId}`)[0].n as number;

  beforeAll(async () => {
    [{ id: ws }] = await sql`insert into workspaces (name, slug) values ('Follow-up ops', ${"fu-" + randomUUID()}) returning id`;
    [{ id: ownerId }] = await sql`insert into users (email) values (${`owner-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("without a configured sequence the rep gets a task, assigned to the account owner, with the reason", async () => {
    const w = await sentWelcome({ prospect: true });
    const fu = await startFollowUp(db, w.event, deps);
    expect(fu).toMatchObject({ mode: "task", enrollment_id: null });
    expect(fu.task_reason).toMatch(/^no_sequence_configured/);
    const [task] = await sql`select assigned_to, type, related_entity_id, status from tasks where id = ${fu.task_id}`;
    expect(task).toMatchObject({ assigned_to: ownerId, type: "onboarding_check", related_entity_id: w.accountId, status: "open" });
    expect(await eventsFor(w.accountId, "TaskCreated")).toBe(1);
  });

  it("a redelivered WelcomeEmailSent creates nothing new", async () => {
    const w = await sentWelcome();
    const first = await startFollowUp(db, w.event, deps);
    const again = await startFollowUp(db, w.event, deps);
    expect(again.id).toBe(first.id);
    const [n] = await sql`select count(*)::int as n from tasks where related_entity_id = ${w.accountId}`;
    expect(n.n).toBe(1);
    expect(await eventsFor(w.accountId, "TaskCreated")).toBe(1);
  });

  describe("with the onboarding sequence configured", () => {
    let sequenceId = "";
    beforeAll(async () => {
      sequenceId = await configureSequence();
    });

    it("enrolls a contact that maps to a prospect, stores the template version and schedules the first step", async () => {
      const w = await sentWelcome({ prospect: true });
      await sql`insert into consents (workspace_id, subject_type, subject_id, type, basis) values (${ws}, 'prospect', ${w.prospectId}, 'email', 'contract')`;
      scheduleFirstStep.mockClear();
      const fu = await startFollowUp(db, w.event, deps);
      expect(fu).toMatchObject({ mode: "sequence", task_id: null });
      const [enr] = await sql`select sequence_id, prospect_id, status, sequence_version_id from sequence_enrollments where id = ${fu.enrollment_id}`;
      expect(enr).toMatchObject({ sequence_id: sequenceId, prospect_id: w.prospectId, status: "active" });
      expect(enr.sequence_version_id).toBeTruthy();
      expect(scheduleFirstStep).toHaveBeenCalledTimes(1);
      expect(await eventsFor(w.accountId, "SequenceEnrolled")).toBe(1);
    });

    it("a contact without a prospect, or with no consent for outreach, gets a task instead", async () => {
      const noProspect = await sentWelcome({ prospect: false });
      expect((await startFollowUp(db, noProspect.event, deps)).task_reason).toMatch(/^contact_without_prospect/);

      const noConsent = await sentWelcome({ prospect: true });
      const fu = await startFollowUp(db, noConsent.event, deps);
      expect(fu.mode).toBe("task");
      expect(fu.task_reason).toMatch(/^contact_blocked: .*no_consent/);
    });

    it("an email sent to someone who is not a contact still produces a task", async () => {
      const w = await sentWelcome({ contact: false });
      expect((await startFollowUp(db, w.event, deps)).task_reason).toMatch(/^no_contact/);
    });
  });
});
