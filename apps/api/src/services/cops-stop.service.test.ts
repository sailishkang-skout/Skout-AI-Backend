import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { claimScheduledStep } from "./sequence-step-claim.js";
import { pauseEnrollment, resumeEnrollment, stopAccountFollowUps, stopEnrollment, STOP_REASONS } from "./cops-stop.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-05 acceptance "each stop condition has a test proving no further step fires; activation
 * mid-step cancels the pending step", against a real Postgres. "No further step fires" is checked
 * the way the worker decides it: claimScheduledStep must refuse every step after a stop.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-05 stop conditions (Postgres)", () => {
  const sql = postgres(url as string, { max: 4, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws = "";
  let userId = "";
  let sequenceId = "";
  const stepIds: string[] = [];

  /** An account with an active follow-up enrollment and three scheduled steps. */
  async function followUp() {
    const [co] = await sql`insert into companies (workspace_id, name) values (${ws}, ${"Stop " + randomUUID().slice(0, 6)}) returning id`;
    const [enr] = await sql`insert into sequence_enrollments (workspace_id, sequence_id, prospect_id, status) values (${ws}, ${sequenceId}, ${"p-" + randomUUID()}, 'active') returning id`;
    const steps: string[] = [];
    for (const stepId of stepIds) {
      const [s] = await sql`insert into sequence_enrollment_steps (enrollment_id, step_id, status, scheduled_at) values (${enr.id}, ${stepId}, 'scheduled', now()) returning id`;
      steps.push(s.id);
    }
    const [task] = await sql`insert into tasks (workspace_id, title) values (${ws}, 'unused') returning id`;
    void task;
    await sql`insert into cops_follow_ups (workspace_id, account_id, source_event_id, mode, enrollment_id) values (${ws}, ${co.id}, gen_random_uuid(), 'sequence', ${enr.id})`;
    return { accountId: co.id as string, enrollmentId: enr.id as string, steps };
  }

  beforeAll(async () => {
    [{ id: ws }] = await sql`insert into workspaces (name, slug) values ('Stop ops', ${"stop-" + randomUUID()}) returning id`;
    [{ id: userId }] = await sql`insert into users (email) values (${`rep-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    [{ id: sequenceId }] = await sql`insert into sequences (workspace_id, name, status, template_key, current_version) values (${ws}, 'FU', 'active', 'cops_onboarding_followup', 1) returning id`;
    for (const [i, type] of ["email", "task", "call"].entries()) {
      const [st] = await sql`insert into sequence_steps (sequence_id, step_order, step_type, delay_days) values (${sequenceId}, ${i + 1}, ${type}, ${i}) returning id`;
      stepIds.push(st.id);
    }
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  for (const reason of STOP_REASONS) {
    it(`${reason}: stops the follow-up, cancels pending steps, and no further step can start`, async () => {
      const f = await followUp();
      const res = await stopEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, reason, actor: { type: "system", id: null }, correlationId: randomUUID() });
      expect(res).toEqual({ stopped: true, cancelledSteps: 3 });
      const [enr] = await sql`select status, stop_reason from sequence_enrollments where id = ${f.enrollmentId}`;
      expect(enr).toEqual({ status: "stopped", stop_reason: reason });
      for (const step of f.steps) expect(await claimScheduledStep(db, f.enrollmentId, step)).toBe(false);
      const [ev] = await sql`select count(*)::int as n from sequence_events where enrollment_id = ${f.enrollmentId} and event_type = 'sequence_stopped'`;
      expect(ev.n).toBe(1);
    });
  }

  it("activation mid-step: the step already running finishes, every pending step is cancelled", async () => {
    const f = await followUp();
    expect(await claimScheduledStep(db, f.enrollmentId, f.steps[0]!)).toBe(true);
    const stopped = await stopAccountFollowUps(db, { workspaceId: ws, accountId: f.accountId, reason: "ACTIVATED", actor: { type: "system", id: null }, correlationId: randomUUID() });
    expect(stopped).toBe(1);
    const steps = await sql`select id, status from sequence_enrollment_steps where enrollment_id = ${f.enrollmentId} order by scheduled_at, id`;
    const byId = Object.fromEntries(steps.map((s: { id: string; status: string }) => [s.id, s.status]));
    expect(byId[f.steps[0]!]).toBe("executing");
    expect(byId[f.steps[1]!]).toBe("cancelled");
    expect(byId[f.steps[2]!]).toBe("cancelled");
  });

  it("a stop racing a step claim never lets a step start after the stop committed (50 races)", async () => {
    for (let i = 0; i < 50; i += 1) {
      const f = await followUp();
      const [claimed, stop] = await Promise.all([
        claimScheduledStep(db, f.enrollmentId, f.steps[0]!),
        stopEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, reason: "REPLIED", actor: { type: "system", id: null }, correlationId: randomUUID() }),
      ]);
      expect(stop.stopped).toBe(true);
      const [s] = await sql`select status from sequence_enrollment_steps where id = ${f.steps[0]}`;
      // Exactly one of the two won the first step; nothing is ever both started and cancelled.
      expect(s.status).toBe(claimed ? "executing" : "cancelled");
      expect(stop.cancelledSteps).toBe(claimed ? 2 : 3);
    }
  });

  it("a second stop keeps the first reason; a stopped follow-up cannot be paused or resumed", async () => {
    const f = await followUp();
    await stopEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, reason: "MEETING_BOOKED", actor: { type: "system", id: null }, correlationId: randomUUID() });
    expect((await stopEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, reason: "REP_STOPPED", actor: { type: "user", id: userId }, correlationId: randomUUID() })).stopped).toBe(false);
    const [enr] = await sql`select stop_reason from sequence_enrollments where id = ${f.enrollmentId}`;
    expect(enr.stop_reason).toBe("MEETING_BOOKED");
    await expect(pauseEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, actor: { type: "user", id: userId }, reason: "x", correlationId: randomUUID() })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
  });

  it("pause holds every step; resume re-queues the next one; both are audited", async () => {
    const f = await followUp();
    await pauseEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, actor: { type: "user", id: userId }, reason: "Customer asked for a week", correlationId: randomUUID() });
    expect(await claimScheduledStep(db, f.enrollmentId, f.steps[0]!)).toBe(false);
    const scheduleNext = vi.fn(async () => {});
    await resumeEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, actor: { type: "user", id: userId }, correlationId: randomUUID() }, scheduleNext);
    expect(scheduleNext).toHaveBeenCalledWith(expect.objectContaining({ enrollmentId: f.enrollmentId, sequenceId }));
    expect(await claimScheduledStep(db, f.enrollmentId, f.steps[0]!)).toBe(true);
    const audits = await sql`select action, reason from audit_logs where entity_id = ${f.enrollmentId} order by created_at`;
    expect(audits.map((a: { action: string }) => a.action)).toEqual(["follow_up.paused", "follow_up.resumed"]);
    expect(audits[0].reason).toBe("Customer asked for a week");
  });

  it("a rep stop needs no extra lookups and is audited with the rep's note", async () => {
    const f = await followUp();
    await stopEnrollment(db, { workspaceId: ws, enrollmentId: f.enrollmentId, reason: "REP_STOPPED", actor: { type: "user", id: userId }, note: "Handled by phone", correlationId: randomUUID() });
    const [a] = await sql`select action, reason from audit_logs where entity_id = ${f.enrollmentId}`;
    expect(a).toEqual({ action: "follow_up.stopped", reason: "Handled by phone" });
    // The stop lands on the account timeline (activity + ActivityRecorded).
    const [act] = await sql`select subject from activities where entity_type = 'company' and entity_id = ${f.accountId}`;
    expect(act.subject).toBe("Onboarding follow-up stopped: REP_STOPPED: Handled by phone");
    const [ev] = await sql`select count(*)::int as n from cops_outbox where event_type = 'ActivityRecorded' and envelope->'payload'->>'account_id' = ${f.accountId}`;
    expect(ev.n).toBe(1);
  });
});
