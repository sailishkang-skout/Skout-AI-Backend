import { eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { NodeExecutionContext } from "./types.js";

const { automationStepEffects } = schema;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * COPS-10 exactly-once action (Bible p.74). Runs `effect` and records its output against the
 * step's idempotency key in one transaction. If the step already made its effect (a worker
 * crashed after the commit and the step was reclaimed), the recorded output is returned and
 * nothing runs again. Without a step key (a direct call) the effect simply runs.
 */
export async function withStepEffect(
  ctx: NodeExecutionContext,
  effectType: string,
  effect: (tx: Tx) => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const key = ctx.stepKey;
  if (!key) return ctx.db.transaction((tx) => effect(tx));
  return ctx.db.transaction(async (tx) => {
    const [done] = await tx.select().from(automationStepEffects).where(eq(automationStepEffects.stepKey, key)).for("update").limit(1);
    if (done) return { ...(done.output as Record<string, unknown>), replayed: true };
    const output = await effect(tx);
    await tx.insert(automationStepEffects).values({ stepKey: key, workspaceId: ctx.workspaceId, automationRunId: ctx.runId, nodeId: ctx.node.id, effectType, output });
    return output;
  });
}
