import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import {
  runSmartListQueryWithFallback,
  type OpenSearchConfig,
  type SearchFilters,
} from "@skout/opensearch";
import type { Env } from "../config/env.js";
import {
  computeNextRefreshAt,
  type SmartListRefreshCadence,
} from "./smart-list-cadence.js";

const log = createLogger("smart-list.service");
const { smartLists } = schema;

export function osConfigFromEnv(config: Env): OpenSearchConfig | null {
  if (!config.OPENSEARCH_URL) return null;
  return {
    url: config.OPENSEARCH_URL,
    username: config.OPENSEARCH_USERNAME,
    password: config.OPENSEARCH_PASSWORD,
    index: config.OPENSEARCH_INDEX,
  };
}

export interface SmartListRecord {
  id: string;
  workspaceId: string;
  name: string;
  filters: SearchFilters;
  lastRunCount: number | null;
  refreshCadence: SmartListRefreshCadence;
  nextRefreshAt: Date | null;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** In-memory fallback when DATABASE_URL is unset (local dev without Postgres). */
const memoryByWorkspace = new Map<string, SmartListRecord[]>();

function toSmartListRecord(row: typeof smartLists.$inferSelect): SmartListRecord {
  return {
    ...row,
    filters: row.filters as SearchFilters,
    refreshCadence: row.refreshCadence as SmartListRefreshCadence,
  };
}

function memoryLists(workspaceId: string): SmartListRecord[] {
  let lists = memoryByWorkspace.get(workspaceId);
  if (!lists) {
    lists = [];
    memoryByWorkspace.set(workspaceId, lists);
  }
  return lists;
}

export async function listSmartLists(db: Db | null, workspaceId: string): Promise<SmartListRecord[]> {
  if (!db) {
    return [...memoryLists(workspaceId)].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }
  const rows = await db
    .select()
    .from(smartLists)
    .where(eq(smartLists.workspaceId, workspaceId))
    .orderBy(desc(smartLists.updatedAt));
  return rows.map(toSmartListRecord);
}

export async function createSmartList(
  db: Db | null,
  workspaceId: string,
  name: string,
  filters: SearchFilters
): Promise<SmartListRecord> {
  if (!db) {
    const row: SmartListRecord = {
      id: randomUUID(),
      workspaceId,
      name,
      filters,
      lastRunCount: null,
      refreshCadence: "off",
      nextRefreshAt: null,
      lastRefreshedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    memoryLists(workspaceId).push(row);
    log.info("smart list created", { workspaceId, listId: row.id, name });
    return row;
  }
  const [row] = await db
    .insert(smartLists)
    .values({ workspaceId, name, filters })
    .returning();
  const record = toSmartListRecord(row);
  log.info("smart list created", { workspaceId, listId: record.id, name });
  return record;
}

export async function updateSmartList(
  db: Db | null,
  workspaceId: string,
  listId: string,
  patch: { name?: string; filters?: SearchFilters }
): Promise<SmartListRecord | null> {
  if (!db) {
    const list = memoryLists(workspaceId).find((l) => l.id === listId);
    if (!list) return null;
    if (patch.name !== undefined) list.name = patch.name;
    if (patch.filters !== undefined) list.filters = patch.filters;
    list.updatedAt = new Date();
    log.info("smart list updated", { workspaceId, listId });
    return list;
  }
  const [existing] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
  if (!existing || existing.workspaceId !== workspaceId) return null;
  const [row] = await db
    .update(smartLists)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.filters !== undefined ? { filters: patch.filters } : {}),
      updatedAt: new Date(),
    })
    .where(eq(smartLists.id, listId))
    .returning();
  if (row) log.info("smart list updated", { workspaceId, listId });
  return row ? toSmartListRecord(row) : null;
}

export async function deleteSmartList(
  db: Db | null,
  workspaceId: string,
  listId: string
): Promise<boolean> {
  if (!db) {
    const lists = memoryLists(workspaceId);
    const idx = lists.findIndex((l) => l.id === listId);
    if (idx === -1) return false;
    lists.splice(idx, 1);
    log.info("smart list deleted", { workspaceId, listId });
    return true;
  }
  const [existing] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
  if (!existing || existing.workspaceId !== workspaceId) return false;
  await db.delete(smartLists).where(eq(smartLists.id, listId));
  log.info("smart list deleted", { workspaceId, listId });
  return true;
}

export async function runSmartList(
  db: Db | null,
  osCfg: OpenSearchConfig | null,
  workspaceId: string,
  listId: string
) {
  let list: SmartListRecord | undefined;

  if (!db) {
    list = memoryLists(workspaceId).find((l) => l.id === listId);
  } else {
    const [row] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
    list = row ? toSmartListRecord(row) : undefined;
  }

  if (!list || list.workspaceId !== workspaceId) return null;

  const filters = list.filters as SearchFilters;
  const { hits, demo } = await runSmartListQueryWithFallback(osCfg, filters);

  if (!db) {
    list.lastRunCount = hits.length;
    list.updatedAt = new Date();
  } else {
    await db
      .update(smartLists)
      .set({ lastRunCount: hits.length, updatedAt: new Date() })
      .where(eq(smartLists.id, listId));
  }

  log.info("smart list run completed", {
    workspaceId,
    listId,
    total: hits.length,
    demo,
  });

  return { list, hits, total: hits.length, demo };
}

export async function updateSmartListRefreshSchedule(
  db: Db | null,
  workspaceId: string,
  listId: string,
  cadence: SmartListRefreshCadence
): Promise<SmartListRecord | null> {
  const nextRefreshAt = computeNextRefreshAt(cadence, new Date());

  if (!db) {
    const list = memoryLists(workspaceId).find((l) => l.id === listId);
    if (!list) return null;
    list.refreshCadence = cadence;
    list.nextRefreshAt = nextRefreshAt;
    list.updatedAt = new Date();
    log.info("smart list refresh schedule updated", { workspaceId, listId, cadence });
    return list;
  }

  const [existing] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
  if (!existing || existing.workspaceId !== workspaceId) return null;
  const [row] = await db
    .update(smartLists)
    .set({ refreshCadence: cadence, nextRefreshAt, updatedAt: new Date() })
    .where(eq(smartLists.id, listId))
    .returning();
  if (row) log.info("smart list refresh schedule updated", { workspaceId, listId, cadence });
  return row ? toSmartListRecord(row) : null;
}

export interface SmartListRefreshSummary {
  id: string;
  smartListId: string;
  status: string;
  matchedCount: number;
  addedCount: number;
  droppedCount: number;
  creditsCharged: number;
  requiredCredits: number | null;
  availableCredits: number | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface SmartListProspectDiffEntry {
  prospectId: string;
  fullName?: string;
  title?: string;
  companyDomain?: string;
}

export interface SmartListRefreshDetail extends SmartListRefreshSummary {
  addedProspects: SmartListProspectDiffEntry[];
  droppedProspects: SmartListProspectDiffEntry[];
}

function toRefreshSummary(row: typeof schema.smartListRefreshes.$inferSelect): SmartListRefreshSummary {
  return {
    id: row.id,
    smartListId: row.smartListId,
    status: row.status,
    matchedCount: row.matchedCount,
    addedCount: row.addedCount,
    droppedCount: row.droppedCount,
    creditsCharged: row.creditsCharged,
    requiredCredits: row.requiredCredits,
    availableCredits: row.availableCredits,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

export async function listSmartListRefreshes(
  db: Db | null,
  workspaceId: string,
  listId: string,
  limit = 20
): Promise<SmartListRefreshSummary[]> {
  if (!db) return [];
  const [list] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
  if (!list || list.workspaceId !== workspaceId) return [];
  const rows = await db
    .select()
    .from(schema.smartListRefreshes)
    .where(eq(schema.smartListRefreshes.smartListId, listId))
    .orderBy(desc(schema.smartListRefreshes.createdAt))
    .limit(limit);
  return rows.map(toRefreshSummary);
}

export async function getSmartListRefresh(
  db: Db | null,
  workspaceId: string,
  listId: string,
  refreshId: string
): Promise<SmartListRefreshDetail | null> {
  if (!db) return null;
  const [row] = await db
    .select()
    .from(schema.smartListRefreshes)
    .where(eq(schema.smartListRefreshes.id, refreshId));
  if (!row || row.workspaceId !== workspaceId || row.smartListId !== listId) return null;
  return {
    ...toRefreshSummary(row),
    addedProspects: row.addedProspects as SmartListProspectDiffEntry[],
    droppedProspects: row.droppedProspects as SmartListProspectDiffEntry[],
  };
}
