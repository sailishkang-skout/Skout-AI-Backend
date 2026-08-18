import { createHash } from "node:crypto";
import { z } from "zod";

/** Leaf predicates the engine can evaluate (spec §9, §34). */
export const CONDITION_LEAF_TYPES = [
  "linkedin_connected",
  "linkedin_invite_accepted",
  "linkedin_invite_declined",
  "email_opened",
  "email_clicked",
  /** Engagement-intent thresholds ("N opens without a reply") — evaluated against `value`
   * (defaults to 3 when omitted). Distinct from the plain email_opened/email_clicked leaves
   * above, which only check "at least once ever". */
  "email_opened_count_gte",
  "email_clicked_count_gte",
  "email_replied",
  "call_connected",
  "icp_score_gte",
  "has_email",
  "has_linkedin",
  /** Account-level: another contact at the same company already replied positively
   * (condition-engine spec §26/§28) — "the system should never continue automated outreach
   * after a confirmed positive sales conversation" applied at the account, not just contact,
   * level. Broader account-level conditions (already customer, has open opportunity) need the
   * CRM↔GTM prospect identity reconciliation tracked separately (R14.1) as a prerequisite. */
  "account_has_positive_reply",
] as const;
export type ConditionLeafType = (typeof CONDITION_LEAF_TYPES)[number];

export type ConditionExpression =
  | { type: ConditionLeafType; not?: boolean; value?: number }
  | { op: "and" | "or"; not?: boolean; clauses: ConditionExpression[] };

const leafSchema = z.object({
  type: z.enum(CONDITION_LEAF_TYPES),
  not: z.boolean().optional(),
  value: z.number().optional(),
});

export const conditionExpressionSchema: z.ZodType<ConditionExpression> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({
      op: z.enum(["and", "or"]),
      not: z.boolean().optional(),
      clauses: z.array(z.lazy(() => conditionExpressionSchema)).min(1).max(8),
    }),
  ])
);

export function parseConditionExpression(raw: unknown): ConditionExpression | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = conditionExpressionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function expressionFromSingle(type: string | null | undefined): ConditionExpression | null {
  if (!type) return null;
  if (!(CONDITION_LEAF_TYPES as readonly string[]).includes(type)) return null;
  return { type: type as ConditionLeafType };
}

function depthOf(expr: ConditionExpression, depth = 1): number {
  if (!("op" in expr)) return depth;
  return Math.max(depth, ...expr.clauses.map((c) => depthOf(c, depth + 1)));
}

export function assertConditionExpression(expr: ConditionExpression): void {
  if (depthOf(expr) > 4) {
    throw new Error("Compound conditions may nest at most 4 levels");
  }
}

export async function evaluateConditionExpression(
  expr: ConditionExpression,
  evalLeaf: (type: ConditionLeafType, value?: number) => Promise<boolean>
): Promise<{ passed: boolean; evidence: Record<string, unknown> }> {
  async function walk(node: ConditionExpression): Promise<{ passed: boolean; evidence: Record<string, unknown> }> {
    if ("type" in node) {
      const raw = await evalLeaf(node.type, node.value);
      const passed = node.not ? !raw : raw;
      return { passed, evidence: { type: node.type, not: Boolean(node.not), value: node.value, raw, passed } };
    }
    const children = [];
    for (const clause of node.clauses) {
      children.push(await walk(clause));
    }
    const raw = node.op === "and" ? children.every((c) => c.passed) : children.some((c) => c.passed);
    const passed = node.not ? !raw : raw;
    return { passed, evidence: { op: node.op, not: Boolean(node.not), passed, clauses: children.map((c) => c.evidence) } };
  }
  return walk(expr);
}

/** Deterministic A/B assignment — same prospect always gets the same variant (spec §30). */
export function assignExperimentVariant(
  experimentId: string,
  prospectId: string,
  weightA = 50,
  weightB = 50
): "A" | "B" {
  const total = Math.max(1, weightA + weightB);
  const digest = createHash("sha256").update(`${experimentId}:${prospectId}`).digest();
  const n = digest.readUInt32BE(0) % total;
  return n < weightA ? "A" : "B";
}

export const SEQUENCE_EVENT_TYPES = [
  "sequence_started",
  "sequence_paused",
  "sequence_resumed",
  "sequence_stopped",
  "sequence_completed",
  "node_entered",
  "node_completed",
  "condition_evaluated",
  "branch_selected",
  "action_scheduled",
  "action_sent",
  "action_failed",
  "fallback_triggered",
  "retry_scheduled",
] as const;
export type SequenceEventType = (typeof SEQUENCE_EVENT_TYPES)[number];
