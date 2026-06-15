import type { Db } from "@skout/db";
import { schema } from "@skout/db";
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

  await db
    .insert(creditBalances)
    .values({ workspaceId: DEMO_WORKSPACE_ID, balance: 500 })
    .onConflictDoUpdate({
      target: creditBalances.workspaceId,
      set: { balance: 500, updatedAt: new Date() },
    });
}
