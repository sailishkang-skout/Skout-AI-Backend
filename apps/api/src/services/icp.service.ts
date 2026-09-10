import { eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { IcpConfig, OnboardingProfile } from "./enrichment/ai-client.js";

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
  const [row] = await db.select().from(workspaceIcp).where(scopedTo(workspaceIcp, workspaceId));
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
    onboarding: cfg.onboarding as OnboardingProfile | undefined,
  };
}

/**
 * Persist ICP. Settings saves often omit `onboarding`; always preserve an existing
 * onboarding profile (especially `completedAt`) so the setup gate does not reopen.
 */
export function mergeIcpConfig(existing: IcpConfig, incoming: IcpConfig): IcpConfig {
  const onboarding =
    incoming.onboarding === undefined
      ? existing.onboarding
      : {
          ...existing.onboarding,
          ...incoming.onboarding,
          completedAt: incoming.onboarding.completedAt ?? existing.onboarding?.completedAt,
        };

  return { ...incoming, onboarding };
}

export async function setWorkspaceIcp(db: Db | null, workspaceId: string, config: IcpConfig) {
  const existing = await getWorkspaceIcp(db, workspaceId);
  const merged = mergeIcpConfig(existing, config);

  if (!db) {
    const prev = memoryIcpByWorkspace.get(workspaceId);
    const version = (prev?.version ?? 0) + 1;
    memoryIcpByWorkspace.set(workspaceId, { config: merged, version });
    return { workspaceId, config: merged, version };
  }
  const [row] = await db
    .insert(workspaceIcp)
    .values({ workspaceId, config: merged, version: 1 })
    .onConflictDoUpdate({
      target: workspaceIcp.workspaceId,
      set: {
        config: merged,
        version: sql`${workspaceIcp.version} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function getWorkspaceIcpVersion(db: Db | null, workspaceId: string): Promise<number> {
  if (!db) return memoryIcpByWorkspace.get(workspaceId)?.version ?? 0;
  const [row] = await db.select().from(workspaceIcp).where(scopedTo(workspaceIcp, workspaceId));
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
