import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import {
  runSmartListQueryWithFallback,
  type OpenSearchConfig,
  type SearchFilters,
} from "@skout/opensearch";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import {
  computeNextRefreshAt,
  type SmartListRefreshCadence,
} from "./smart-list-cadence.js";

const log = createLogger("smart-list.service");
const { smartLists } = schema;

function humanizeFilterKey(key: string): string {
  return key.replace(/([A-Z])/g, " $1").toLowerCase().trim();
}

/**
 * 8.2 Ask — "every dynamic-list membership change should show which signal or filter change
 * moved a record in or out". A smart list's membership is a live re-run of its saved filters
 * (signal-based criteria like `contactSignals`/`companySignals`/`signal` included), so the
 * honest, non-fabricated explanation for *any* record's move is exactly this: the list's active
 * filter criteria at refresh time. Reused for both added ("now matches") and dropped ("no longer
 * matches") entries.
 */
export function summarizeSearchFilters(filters: SearchFilters): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    const label = humanizeFilterKey(key);
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      parts.push(`${label}: ${value.join(", ")}`);
    } else if (typeof value === "boolean") {
      if (value) parts.push(label);
    } else {
      parts.push(`${label}: ${value}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : "no filters set (matches everything)";
}

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
    .where(scopedTo(smartLists, workspaceId))
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
  /** Which filter criteria (including signal-based ones) moved this record in or out. */
  matchReason?: string;
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
): Promise<SmartListRefreshDetail[]> {
  if (!db) return [];
  const [list] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
  if (!list || list.workspaceId !== workspaceId) return [];
  const rows = await db
    .select()
    .from(schema.smartListRefreshes)
    .where(eq(schema.smartListRefreshes.smartListId, listId))
    .orderBy(desc(schema.smartListRefreshes.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    ...toRefreshSummary(row),
    addedProspects: row.addedProspects as SmartListProspectDiffEntry[],
    droppedProspects: row.droppedProspects as SmartListProspectDiffEntry[],
  }));
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

/**
 * Undo one refresh's membership change: puts the prospects it dropped back, takes the
 * prospects it added back out, and records the reverse as a new "reverted" history entry
 * (so the timeline stays a complete, explainable log rather than rewriting history).
 * Only the most recent refresh for a list is revertible — membership is a single current
 * snapshot, not a ledger, so reverting an older refresh would be ambiguous.
 */
export async function revertSmartListRefresh(
  db: Db | null,
  workspaceId: string,
  listId: string,
  refreshId: string
): Promise<SmartListRefreshDetail | null> {
  if (!db) return null;
  const [list] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
  if (!list || list.workspaceId !== workspaceId) return null;

  const [refresh] = await db
    .select()
    .from(schema.smartListRefreshes)
    .where(eq(schema.smartListRefreshes.id, refreshId));
  if (!refresh || refresh.workspaceId !== workspaceId || refresh.smartListId !== listId) return null;
  if (refresh.status !== "completed") {
    throw new HttpError("refresh_not_revertible", 409);
  }

  const [latest] = await db
    .select({ id: schema.smartListRefreshes.id })
    .from(schema.smartListRefreshes)
    .where(eq(schema.smartListRefreshes.smartListId, listId))
    .orderBy(desc(schema.smartListRefreshes.createdAt))
    .limit(1);
  if (!latest || latest.id !== refreshId) {
    throw new HttpError("only_latest_refresh_revertible", 409);
  }

  const addedProspects = refresh.addedProspects as SmartListProspectDiffEntry[];
  const droppedProspects = refresh.droppedProspects as SmartListProspectDiffEntry[];

  if (addedProspects.length > 0) {
    await db
      .delete(schema.smartListMembers)
      .where(
        and(
          eq(schema.smartListMembers.smartListId, listId),
          inArray(
            schema.smartListMembers.prospectId,
            addedProspects.map((p) => p.prospectId)
          )
        )
      );
  }
  if (droppedProspects.length > 0) {
    await db.insert(schema.smartListMembers).values(
      droppedProspects.map((p) => ({
        smartListId: listId,
        prospectId: p.prospectId,
        snapshot: p,
      }))
    );
  }

  const now = new Date();
  const newCount = refresh.matchedCount - addedProspects.length + droppedProspects.length;

  await db
    .update(smartLists)
    .set({ lastRunCount: newCount, updatedAt: now })
    .where(eq(smartLists.id, listId));

  const [revertRow] = await db
    .insert(schema.smartListRefreshes)
    .values({
      workspaceId,
      smartListId: listId,
      status: "reverted",
      matchedCount: newCount,
      addedCount: droppedProspects.length,
      droppedCount: addedProspects.length,
      addedProspects: droppedProspects,
      droppedProspects: addedProspects,
      creditsCharged: 0,
      startedAt: now,
      completedAt: now,
    })
    .returning();

  log.info("smart list refresh reverted", { workspaceId, listId, revertedRefreshId: refreshId });

  return {
    ...toRefreshSummary(revertRow!),
    addedProspects: droppedProspects,
    droppedProspects: addedProspects,
  };
}
