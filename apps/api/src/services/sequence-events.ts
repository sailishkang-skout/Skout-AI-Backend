import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { SequenceEventType } from "./sequence-condition.js";

const log = createLogger("sequence-events");
const { sequenceEvents } = schema;

export async function recordSequenceEvent(
  db: Db,
  input: {
    workspaceId: string;
    sequenceId: string;
    enrollmentId?: string | null;
    sequenceVersionId?: string | null;
    prospectId?: string | null;
    stepId?: string | null;
    eventType: SequenceEventType | string;
    variantKey?: string | null;
    branch?: string | null;
    result?: string | null;
    reason?: string | null;
    evidence?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await db.insert(sequenceEvents).values({
      workspaceId: input.workspaceId,
      sequenceId: input.sequenceId,
      enrollmentId: input.enrollmentId ?? null,
      sequenceVersionId: input.sequenceVersionId ?? null,
      prospectId: input.prospectId ?? null,
      stepId: input.stepId ?? null,
      eventType: input.eventType,
      variantKey: input.variantKey ?? null,
      branch: input.branch ?? null,
      result: input.result ?? null,
      reason: input.reason ?? null,
      evidence: input.evidence ?? {},
    });
  } catch (err) {
    log.warn("sequence event persist failed", { err, eventType: input.eventType, enrollmentId: input.enrollmentId });
  }
}
