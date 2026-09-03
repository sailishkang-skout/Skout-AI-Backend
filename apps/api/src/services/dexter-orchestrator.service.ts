import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";

const { dexterTriggers } = schema;

export interface DexterTrigger {
  id: string;
  workspaceId: string;
  eventType: string;
  actionType: string;
  actionParams: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
}

export async function matchTriggers(
  db: Db,
  workspaceId: string,
  eventType: string
): Promise<DexterTrigger[]> {
  const rows = await db
    .select()
    .from(dexterTriggers)
    .where(
      scopedTo(dexterTriggers, workspaceId, eq(dexterTriggers.eventType, eventType), eq(dexterTriggers.enabled, true))
    );
  return rows as DexterTrigger[];
}
