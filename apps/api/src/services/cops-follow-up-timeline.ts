import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendActivityRecorded } from "@skout/shared";
import { createLogger } from "@skout/observability";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-05 additions).
 *   - Tables touched directly: activities - write (one row per follow-up step or stop) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the activity and its ActivityRecorded event commit together (COPS-02 timeline contract).
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */

/**
 * COPS-05 "each step updates timeline + next action": a step of an onboarding follow-up that starts,
 * and a follow-up that stops, write an activity on the account with its ActivityRecorded event, so the
 * Customer 360 timeline shows them. Task and call steps already create CRM tasks, which are the
 * account's next actions. Best effort: a timeline failure never blocks the step itself.
 */
const log = createLogger("cops-follow-up-timeline");
const { copsFollowUps, activities, sequenceSteps } = schema;

export async function recordFollowUpActivity(
  db: Db,
  input: { workspaceId: string; enrollmentId: string; kind: "step_started" | "stopped"; stepId?: string | null; detail?: string | null }
): Promise<void> {
  try {
    const [fu] = await db
      .select({ accountId: copsFollowUps.accountId })
      .from(copsFollowUps)
      .where(and(eq(copsFollowUps.workspaceId, input.workspaceId), eq(copsFollowUps.enrollmentId, input.enrollmentId)))
      .limit(1);
    if (!fu) return;
    let stepLabel: string | null = null;
    if (input.stepId) {
      const [st] = await db.select({ subject: sequenceSteps.subject, type: sequenceSteps.stepType }).from(sequenceSteps).where(eq(sequenceSteps.id, input.stepId));
      stepLabel = st?.subject ?? st?.type ?? null;
    }
    const subject =
      input.kind === "step_started"
        ? `Onboarding follow-up step: ${stepLabel ?? "next step"}`
        : `Onboarding follow-up stopped: ${input.detail ?? "stopped"}`;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(activities)
        .values({ workspaceId: input.workspaceId, entityType: "company", entityId: fu.accountId, activityType: "workflow", subject, body: input.detail ?? null })
        .returning({ id: activities.id });
      await appendActivityRecorded(tx as never, {
        workspaceId: input.workspaceId,
        activityId: row!.id,
        activityType: "workflow",
        entityType: "company",
        entityId: fu.accountId,
        subject,
      });
    });
  } catch (err) {
    log.warn("follow-up timeline entry failed", { err, enrollmentId: input.enrollmentId });
  }
}
