import { sql } from "drizzle-orm";
import type { Db } from "@skout/db";

/**
 * COPS-05 race-safe cancellation (Bible p.74: "provide cancellation when stop conditions occur").
 *
 * A side-effecting step (email, task, call, LinkedIn, WhatsApp) is claimed with one atomic UPDATE
 * just before it runs: `scheduled -> executing`, only while its enrollment is still `active`.
 * A stop (stopEnrollment) sets the enrollment terminal and cancels `scheduled` steps in one
 * transaction. Postgres row locks order the two, so once a stop has committed no further step can
 * start; a step that won the claim had already started before the stop.
 *
 * `executed_at` holds the claim time. A worker that dies after claiming leaves the step
 * `executing`; the advance query picks it up again after STALE_CLAIM_MS so the enrollment never
 * hangs.
 */
export const STALE_CLAIM_MS = 15 * 60 * 1000;

export const SIDE_EFFECT_STEP_TYPES = new Set(["email", "task", "call", "linkedin", "whatsapp"]);

export async function claimScheduledStep(db: Pick<Db, "execute">, enrollmentId: string, enrollmentStepId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const result = await db.execute(sql`
    update sequence_enrollment_steps s
       set status = 'executing', executed_at = now()
     where s.id = ${enrollmentStepId}
       and s.enrollment_id = ${enrollmentId}
       and (s.status = 'scheduled' or (s.status = 'executing' and s.executed_at < ${staleBefore}::timestamptz))
       and exists (select 1 from sequence_enrollments e where e.id = ${enrollmentId} and e.status = 'active')
     returning s.id`);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return Array.isArray(rows) && rows.length > 0;
}
