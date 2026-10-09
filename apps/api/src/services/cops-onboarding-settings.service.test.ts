import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { getOnboardingSettings, handleTicketEscalated, setOnboardingSettings } from "./cops-onboarding-settings.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** COPS-05 Appendix C "critical support escalation if configured": off by default, opt-in, audited. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-05 critical escalation stop (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws = "";
  let userId = "";
  let stepId = "";
  let sequenceId = "";

  async function followUp() {
    const [co] = await sql`insert into companies (workspace_id, name) values (${ws}, ${"Esc " + randomUUID().slice(0, 6)}) returning id`;
    const [enr] = await sql`insert into sequence_enrollments (workspace_id, sequence_id, prospect_id, status) values (${ws}, ${sequenceId}, ${"p-" + randomUUID()}, 'active') returning id`;
    await sql`insert into sequence_enrollment_steps (enrollment_id, step_id, status, scheduled_at) values (${enr.id}, ${stepId}, 'scheduled', now() + interval '1 day')`;
    await sql`insert into cops_follow_ups (workspace_id, account_id, source_event_id, mode, enrollment_id) values (${ws}, ${co.id}, gen_random_uuid(), 'sequence', ${enr.id})`;
    return { accountId: co.id as string, enrollmentId: enr.id as string };
  }
  const escalate = (accountId: string, severity: string) =>
    handleTicketEscalated(db, { tenant_id: ws, correlation_id: randomUUID(), payload: { account_id: accountId, severity } });
  const status = async (id: string) => (await sql`select status, stop_reason from sequence_enrollments where id = ${id}`)[0];

  beforeAll(async () => {
    [{ id: ws }] = await sql`insert into workspaces (name, slug) values ('Esc ops', ${"esc-" + randomUUID()}) returning id`;
    [{ id: userId }] = await sql`insert into users (email) values (${`admin-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    [{ id: sequenceId }] = await sql`insert into sequences (workspace_id, name, status, template_key, current_version) values (${ws}, 'FU', 'active', 'cops_onboarding_followup', 1) returning id`;
    [{ id: stepId }] = await sql`insert into sequence_steps (sequence_id, step_order, step_type, delay_days) values (${sequenceId}, 1, 'task', 1) returning id`;
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("is off by default: a critical escalation does not stop the follow-up", async () => {
    expect((await getOnboardingSettings(db, ws)).stop_on_critical_escalation).toBe(false);
    const f = await followUp();
    expect(await escalate(f.accountId, "critical")).toBe(0);
    expect((await status(f.enrollmentId)).status).toBe("active");
  });

  it("once enabled (audited with a reason), a critical escalation stops it and a lower severity does not", async () => {
    const ctx = { workspaceId: ws, userId, requestId: randomUUID() };
    expect((await setOnboardingSettings(db, ctx, { stop_on_critical_escalation: true, reason: "Pause outreach during P1s" })).stop_on_critical_escalation).toBe(true);
    const [audit] = await sql`select action, reason, is_override from audit_logs where entity_id = ${ws} and action = 'onboarding_settings.updated'`;
    expect(audit).toMatchObject({ reason: "Pause outreach during P1s", is_override: true });

    const low = await followUp();
    expect(await escalate(low.accountId, "P3")).toBe(0);
    expect((await status(low.enrollmentId)).status).toBe("active");

    const crit = await followUp();
    expect(await escalate(crit.accountId, "P1")).toBe(1);
    expect(await status(crit.enrollmentId)).toEqual({ status: "stopped", stop_reason: "CRITICAL_ESCALATION" });
    const [cancelled] = await sql`select status from sequence_enrollment_steps where enrollment_id = ${crit.enrollmentId}`;
    expect(cancelled.status).toBe("cancelled");
  });
});
