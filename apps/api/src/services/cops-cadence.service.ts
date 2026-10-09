import { and, eq, gt } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { SequenceService } from "./sequence.service.js";

/**
 * COPS-05 default onboarding follow-up cadence (Bible p.43), created on the existing sequence engine
 * the first time a workspace needs it. Steps are rep actions (task / call), never automatic customer
 * email, so the rep stays accountable for every touch (Bible p.42). Delays are relative to the
 * previous step: Day 0, 1, 3, 6, 10, 14. Admins can edit it like any sequence; an edit publishes a
 * new version and running enrollments keep theirs.
 */
export const FOLLOW_UP_TEMPLATE_KEY = "cops_onboarding_followup";

export const DEFAULT_CADENCE: Array<{ day: number; stepType: "task" | "call"; subject: string; bodyTemplate: string }> = [
  { day: 0, stepType: "task", subject: "Day 0: confirm the welcome email and workspace access", bodyTemplate: "Check the onboarding email was delivered and the workspace invite is valid." },
  { day: 1, stepType: "call", subject: "Day 1: verify access; call if there is no login", bodyTemplate: "Confirm the admin can sign in. If they have not, call and walk them through it." },
  { day: 3, stepType: "task", subject: "Day 3: review product usage and help with the first result", bodyTemplate: "Look at the activation checklist and help with the first search or export." },
  { day: 6, stepType: "task", subject: "Day 5-7: offer guided onboarding or unblock the integration", bodyTemplate: "Offer a guided session; resolve any integration blocker or open an escalation." },
  { day: 10, stepType: "task", subject: "Day 10: commercial or adoption checkpoint", bodyTemplate: "Based on progress, check adoption or open the commercial conversation." },
  { day: 14, stepType: "call", subject: "Day 14: trial review (convert, extend or disposition)", bodyTemplate: "Review the trial outcome with the customer and agree the next step." },
];

const { sequences } = schema;

export async function findFollowUpSequence(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(and(eq(sequences.workspaceId, workspaceId), eq(sequences.templateKey, FOLLOW_UP_TEMPLATE_KEY), eq(sequences.status, "active"), gt(sequences.currentVersion, 0)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Returns the workspace's follow-up sequence, creating and publishing the default when none exists.
 * A partial unique index (migration 0113) allows one per workspace, so concurrent callers converge.
 */
export async function ensureFollowUpSequence(db: Db, workspaceId: string): Promise<string | null> {
  const existing = await findFollowUpSequence(db, workspaceId);
  if (existing) return existing;
  const svc = new SequenceService(db);
  let sequenceId: string;
  try {
    const created = await svc.createSequence(workspaceId, "Onboarding follow-up (default)", { source: "template", templateKey: FOLLOW_UP_TEMPLATE_KEY, mode: "A" });
    sequenceId = (created as { id: string }).id;
  } catch {
    // Another caller created it first (unique index); wait for it to finish publishing.
    for (let i = 0; i < 50; i += 1) {
      const id = await findFollowUpSequence(db, workspaceId);
      if (id) return id;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  let previousDay = 0;
  for (const step of DEFAULT_CADENCE) {
    await svc.addStep(workspaceId, sequenceId, {
      stepType: step.stepType,
      delayDays: step.day - previousDay,
      delayUnit: "days",
      subject: step.subject,
      bodyTemplate: step.bodyTemplate,
    });
    previousDay = step.day;
  }
  // Activating a draft publishes version 1 (SequenceService.updateSequence).
  await svc.updateSequence(workspaceId, sequenceId, { status: "active" });
  return findFollowUpSequence(db, workspaceId);
}
