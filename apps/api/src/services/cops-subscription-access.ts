import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { HttpError } from "@skout/auth";

/**
 * COPS-08 failed-payment restrictions (Aditya, 2026-10-13). From day 8 a workspace with an unpaid
 * subscription bill cannot use new credits, run enrichment that costs credits, or send outreach.
 * Login and payment still work, and nothing is deleted. Paying restores everything on the next
 * billing pass.
 *
 * The state is read from the `subscription` entitlement that the billing pass keeps on the
 * customer's own workspace, so product code does not need to know about CustomerOps tables. A
 * workspace with no such entitlement (internal workspaces, trials) is never restricted.
 */
const { entitlements } = schema;

export const SUBSCRIPTION_ENTITLEMENT_KEY = "subscription";
export type SubscriptionAccessBlock = "restricted" | "suspended" | "closed";
const BLOCKING: readonly string[] = ["restricted", "suspended", "closed"];

/**
 * The stage that blocks paid use for this workspace, or null. Never throws: if the check itself
 * fails, the customer keeps working. Wrongly blocking a paying customer is the worse mistake.
 */
export async function subscriptionAccessBlock(db: Pick<Db, "select">, workspaceId: string): Promise<SubscriptionAccessBlock | null> {
  try {
    const [row] = await db
      .select({ value: entitlements.value })
      .from(entitlements)
      .where(and(eq(entitlements.workspaceId, workspaceId), eq(entitlements.key, SUBSCRIPTION_ENTITLEMENT_KEY)))
      .limit(1);
    const status = (row?.value as { status?: unknown } | null | undefined)?.status;
    return typeof status === "string" && BLOCKING.includes(status) ? (status as SubscriptionAccessBlock) : null;
  } catch {
    return null;
  }
}

/** 402: the workspace has to settle its subscription before this action is available again. */
export class SubscriptionRestrictedError extends HttpError {
  constructor(public readonly stage: SubscriptionAccessBlock) {
    super("subscription_restricted", 402, {
      stage,
      message: "This workspace has an unpaid subscription bill. Pay it on the billing page to use credits and send outreach again.",
    });
    this.name = "SubscriptionRestrictedError";
  }
}

export async function assertSubscriptionAllowsUse(db: Pick<Db, "select">, workspaceId: string): Promise<void> {
  const block = await subscriptionAccessBlock(db, workspaceId);
  if (block) throw new SubscriptionRestrictedError(block);
}
