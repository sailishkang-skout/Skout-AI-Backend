import type { Db } from "@skout/db";
import { schema, postCreditTransaction } from "@skout/db";
import { eq } from "drizzle-orm";

/** Demo tenant used by the frontend until Clerk workspace provisioning lands. */
export const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

const { workspaces, creditBalances } = schema;

/** Ensure demo workspace + credits exist (dev/staging without manual seed). */
export async function ensureDemoWorkspace(db: Db, workspaceId: string): Promise<void> {
  if (workspaceId !== DEMO_WORKSPACE_ID) return;

  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, DEMO_WORKSPACE_ID))
    .limit(1);

  if (!existing) {
    await db.insert(workspaces).values({
      id: DEMO_WORKSPACE_ID,
      name: "Demo Workspace",
      slug: "demo",
    });
  }

  // Keeps the demo wallet at 500 credits, as before, but through the ledger so the balance always
  // equals the sum of its entries (COPS-04 reconciliation).
  const [wallet] = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.workspaceId, DEMO_WORKSPACE_ID))
    .limit(1);
  const delta = DEMO_CREDITS - (wallet?.balance ?? 0);
  if (delta !== 0) {
    await postCreditTransaction(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      amount: delta,
      kind: "adjustment",
      action: "demo_reset",
      reason: `Demo workspace reset to ${DEMO_CREDITS} credits`,
      actor: { type: "system", id: "demo-workspace" },
      allowNegativeBalance: false,
    });
  }
}

const DEMO_CREDITS = 500;
