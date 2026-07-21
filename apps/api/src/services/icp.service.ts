import { eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { IcpConfig } from "./enrichment/ai-client.js";

const { workspaceIcp } = schema;

interface MemoryIcp {
  config: IcpConfig;
  version: number;
}

/** In-memory fallback when DATABASE_URL is unset. */
const memoryIcpByWorkspace = new Map<string, MemoryIcp>();

export async function getWorkspaceIcp(db: Db | null, workspaceId: string): Promise<IcpConfig> {
  if (!db) {
    return memoryIcpByWorkspace.get(workspaceId)?.config ?? {};
  }
  const [row] = await db.select().from(workspaceIcp).where(eq(workspaceIcp.workspaceId, workspaceId));
  if (!row) return {};
  const cfg = row.config as Record<string, unknown>;
  return {
    industries: cfg.industries as string[] | undefined,
    countries: cfg.countries as string[] | undefined,
    seniorities: cfg.seniorities as string[] | undefined,
    titles: cfg.titles as string[] | undefined,
    keywords: cfg.keywords as string[] | undefined,
    minEmployees: cfg.minEmployees as number | undefined,
    maxEmployees: cfg.maxEmployees as number | undefined,
    companyName: typeof cfg.companyName === "string" ? cfg.companyName : undefined,
    productDescription:
      typeof cfg.productDescription === "string" ? cfg.productDescription : undefined,
    customerPainPoints: cfg.customerPainPoints as string[] | undefined,
    autoRescoreOnChange: cfg.autoRescoreOnChange as boolean | undefined,
  };
}

export async function setWorkspaceIcp(db: Db | null, workspaceId: string, config: IcpConfig) {
  if (!db) {
    const prev = memoryIcpByWorkspace.get(workspaceId);
    const version = (prev?.version ?? 0) + 1;
    memoryIcpByWorkspace.set(workspaceId, { config, version });
    return { workspaceId, config, version };
  }
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

export async function getWorkspaceIcpVersion(db: Db | null, workspaceId: string): Promise<number> {
  if (!db) return memoryIcpByWorkspace.get(workspaceId)?.version ?? 0;
  const [row] = await db.select().from(workspaceIcp).where(eq(workspaceIcp.workspaceId, workspaceId));
  return row?.version ?? 0;
}

export function isIcpConfigured(icp: IcpConfig): boolean {
  return Boolean(
    icp.industries?.length ||
      icp.countries?.length ||
      icp.seniorities?.length ||
      icp.titles?.length ||
      icp.keywords?.length ||
      icp.customerPainPoints?.length ||
      icp.companyName ||
      icp.productDescription ||
      icp.minEmployees != null ||
      icp.maxEmployees != null
  );
}
