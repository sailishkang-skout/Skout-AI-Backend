import { CONDITION_TYPES, type ConditionType } from "./sequence.service.js";

/**
 * AI-generated sequences (Dexter's create_outbound_sequence tool, the chat "sequence" action and
 * POST /sequences/generate) all describe a cadence as a flat step list. Branching uses the same
 * flat shape the built-in templates use: a `condition` step, then the steps that belong to its
 * "yes" / "no" branches tagged with `branch`, then untagged steps back on the main trunk.
 * SequenceService.createGeneratedSequence wires the parent/yes/no links from that order.
 */

export const GENERATED_STEP_TYPES = ["email", "linkedin", "whatsapp", "call", "wait", "task", "condition", "goal"] as const;
export type GeneratedStepType = (typeof GENERATED_STEP_TYPES)[number];

export const GENERATED_LINKEDIN_ACTIONS = ["connect", "message", "inmail", "like", "follow"] as const;
export type GeneratedLinkedinAction = (typeof GENERATED_LINKEDIN_ACTIONS)[number];

export interface GeneratedSequenceStep {
  stepType: GeneratedStepType;
  delayDays: number;
  delayUnit?: "minutes" | "hours" | "days" | "weeks";
  linkedinAction?: GeneratedLinkedinAction;
  subject?: string;
  bodyTemplate?: string;
  conditionType?: ConditionType;
  conditionWaitDays?: number;
  branch?: "yes" | "no" | null;
  goalLabel?: string;
}

const DEFAULT_BODY =
  `<p>Hi {{firstName}},</p><p>Reaching out regarding {{companyName}}.</p>` +
  `<p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>`;

const MESSAGE_TYPES = new Set<GeneratedStepType>(["email", "linkedin", "whatsapp", "call", "task"]);

export function normalizeGeneratedSteps(
  rawSteps: unknown[],
  opts: { fillDefaults?: boolean } = {}
): GeneratedSequenceStep[] {
  const out: GeneratedSequenceStep[] = [];
  let insideCondition = false;

  rawSteps.forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const r = raw as Record<string, unknown>;
    const stepType = (GENERATED_STEP_TYPES as readonly string[]).includes(String(r.stepType))
      ? (r.stepType as GeneratedStepType)
      : "email";
    const delayDays =
      out.length === 0
        ? 0
        : typeof r.delayDays === "number" && Number.isFinite(r.delayDays) && r.delayDays >= 0
          ? Math.floor(r.delayDays)
          : stepType === "condition" || stepType === "goal"
            ? 0
            : 3;
    const step: GeneratedSequenceStep = { stepType, delayDays, delayUnit: "days" };

    if (stepType === "condition") {
      step.conditionType = (CONDITION_TYPES as readonly string[]).includes(String(r.conditionType))
        ? (r.conditionType as ConditionType)
        : "email_replied";
      const wait = typeof r.conditionWaitDays === "number" ? Math.floor(r.conditionWaitDays) : 2;
      step.conditionWaitDays = Math.min(Math.max(wait, 1), 30);
      step.branch = null;
      insideCondition = true;
      out.push(step);
      return;
    }

    const branch = r.branch === "yes" || r.branch === "no" ? r.branch : null;
    step.branch = insideCondition ? branch : null;
    // An untagged step closes the current condition block (back on the main trunk).
    if (!step.branch) insideCondition = false;

    if (stepType === "goal") {
      step.goalLabel =
        typeof r.goalLabel === "string" && r.goalLabel.trim() ? r.goalLabel.trim().slice(0, 120) : "Goal reached";
      out.push(step);
      return;
    }

    if (stepType === "linkedin") {
      step.linkedinAction = (GENERATED_LINKEDIN_ACTIONS as readonly string[]).includes(String(r.linkedinAction))
        ? (r.linkedinAction as GeneratedLinkedinAction)
        : "connect";
    }
    if (stepType === "email") {
      if (typeof r.subject === "string" && r.subject.trim()) step.subject = r.subject.slice(0, 200);
      else if (opts.fillDefaults) step.subject = "Quick question";
    }
    if (MESSAGE_TYPES.has(stepType)) {
      if (typeof r.bodyTemplate === "string" && r.bodyTemplate.trim()) step.bodyTemplate = r.bodyTemplate;
      else if (opts.fillDefaults && stepType !== "call" && stepType !== "task") step.bodyTemplate = DEFAULT_BODY;
    }
    out.push(step);
  });

  return out;
}
