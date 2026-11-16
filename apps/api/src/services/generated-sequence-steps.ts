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

/**
 * Models are far better at nesting than at tagging: given "yes"/"no" arrays on a condition they
 * almost always fill them, whereas the flat `branch` tag on the steps that follow a condition is
 * mostly ignored (measured: ~1 tagged step in 15 conditions). So a condition may carry its own
 * `yes` / `no` step lists; this flattens them into the tagged form the rest of the system uses.
 * The flat form is still accepted as is.
 *
 * Conditions cannot nest inside a branch (the stored shape has one level of branching), so an inner
 * condition is dropped and its steps stay in the branch they were found in.
 */
function expandNestedBranches(rawSteps: unknown[], branch: "yes" | "no" | null = null): unknown[] {
  const out: unknown[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") continue;
    const { yes, no, ...rest } = raw as Record<string, unknown>;
    const isCondition = rest.stepType === "condition";
    const hasNested = Array.isArray(yes) || Array.isArray(no);
    if (isCondition && branch) {
      // Inner condition inside a branch: keep its steps, drop the condition itself.
      out.push(...expandNestedBranches([...(Array.isArray(yes) ? yes : []), ...(Array.isArray(no) ? no : [])], branch));
      continue;
    }
    out.push(branch ? { ...rest, branch } : rest);
    if (isCondition && hasNested) {
      out.push(...expandNestedBranches(Array.isArray(yes) ? yes : [], "yes"));
      out.push(...expandNestedBranches(Array.isArray(no) ? no : [], "no"));
    }
  }
  return out;
}

export function normalizeGeneratedSteps(
  rawSteps: unknown[],
  opts: { fillDefaults?: boolean } = {}
): GeneratedSequenceStep[] {
  const out: GeneratedSequenceStep[] = [];
  let insideCondition = false;

  expandNestedBranches(rawSteps).forEach((raw) => {
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

/**
 * Structural problems worth sending back to the model (or the tool caller) to fix: a condition
 * whose yes/no paths have no steps, and a sequence that doesn't end on a goal. Step numbers are
 * 1-based positions in the flat list, matching what the user sees.
 */
export function validateSequenceStructure(steps: GeneratedSequenceStep[]): string[] {
  const problems: string[] = [];
  steps.forEach((step, i) => {
    if (step.stepType !== "condition") return;
    let yes = 0;
    let no = 0;
    for (let j = i + 1; j < steps.length && steps[j]!.branch; j++) {
      if (steps[j]!.branch === "yes") yes++;
      else no++;
    }
    const n = i + 1;
    if (yes === 0 && no === 0) problems.push(`Condition at step ${n} has no steps on its yes and no paths.`);
    else if (yes === 0) problems.push(`Condition at step ${n} has no steps on its yes path.`);
    else if (no === 0) problems.push(`Condition at step ${n} has no steps on its no path.`);
  });
  if (steps.length > 0 && steps[steps.length - 1]!.stepType !== "goal") {
    problems.push("The last step must be a goal step.");
  }
  return problems;
}

/** Every sequence ends on its goal; add one when the model forgot (deterministic, no copy invented). */
export function ensureGoalEnd(steps: GeneratedSequenceStep[]): GeneratedSequenceStep[] {
  if (steps.length === 0 || steps[steps.length - 1]!.stepType === "goal") return steps;
  return [...steps, { stepType: "goal", delayDays: 0, delayUnit: "days", goalLabel: "Meeting booked", branch: null }];
}

/** The step count the user asked for ("a 15 step sequence", "12-step cadence", "8 steps"), if any. */
export function requestedStepCount(text: string): number | null {
  const m = /\b(\d{1,3})\s*-?\s*steps?\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 && n <= 30 ? n : null;
}
