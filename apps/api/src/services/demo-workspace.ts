import type { Db } from "@skout/db";
import { schema, postCreditTransaction } from "@skout/db";
import { eq } from "drizzle-orm";

/** Demo tenant used by the frontend until Clerk workspace provisioning lands. */
export const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_CREDITS = 500;

const { workspaces, creditBalances } = schema;

/** Ensure demo workspace + credits exist (dev/staging without manual seed). */
export async function ensureDemoWorkspace(db: Db, workspaceId: string): Promise<void> {
  if (workspaceId !== DEMO_WORKSPACE_ID) return;

  // Concurrent callers (parallel test workers, simultaneous first requests) may race here. No
  // conflict target: with `target: id`, a concurrent insert of the same row can still fail on the
  // unique slug index instead of the primary key, which failed test files at random on a fresh
  // database.
  await db
    .insert(workspaces)
    .values({
      id: DEMO_WORKSPACE_ID,
      name: "Demo Workspace",
      slug: "demo",
    })
    .onConflictDoNothing();

  // Keeps the demo wallet at 500 credits on first provision through the ledger
  // so the balance equals the sum of its entries (COPS-04 reconciliation).
  const [wallet] = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.workspaceId, DEMO_WORKSPACE_ID))
    .limit(1);

  if (!wallet) {
    await postCreditTransaction(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      amount: DEMO_CREDITS,
      kind: "grant",
      action: "demo_provision",
      reason: `Initial demo workspace grant of ${DEMO_CREDITS} credits`,
      actor: { type: "system", id: "demo-workspace" },
      allowNegativeBalance: false,
    });
  }
}