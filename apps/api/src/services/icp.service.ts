import { eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { IcpConfig } from "./enrichment/ai-client.js";

const { workspaceIcp } = schema;

export async function getWorkspaceIcp(db: Db | null, workspaceId: string): Promise<IcpConfig> {
  if (!db) return {};
  const [row] = await db.select().from(workspaceIcp).where(eq(workspaceIcp.workspaceId, workspaceId));
  if (!row) return {};
  const cfg = row.config as Record<string, unknown>;
  return {
    industries: cfg.industries as string[] | undefined,
    countries: cfg.countries as string[] | undefined,
    seniorities: cfg.seniorities as string[] | undefined,
    minEmployees: cfg.minEmployees as number | undefined,
    maxEmployees: cfg.maxEmployees as number | undefined,
  };
}

export async function setWorkspaceIcp(db: Db | null, workspaceId: string, config: IcpConfig) {
  if (!db) return { workspaceId, config, version: 1 };
  const [row] = await db
    .insert(workspaceIcp)
    .values({ workspaceId, config, version: 1 })
    .onConflictDoUpdate({
      target: workspaceIcp.workspaceId,
      set: {
        config,
        version: sql`${workspaceIcp.version} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}
