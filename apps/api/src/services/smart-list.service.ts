import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import {
  runSmartListQueryWithFallback,
  type OpenSearchConfig,
  type SearchFilters,
} from "@skout/opensearch";

const { smartLists } = schema;

export interface SmartListRecord {
  id: string;
  workspaceId: string;
  name: string;
  filters: SearchFilters;
  lastRunCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** In-memory fallback when DATABASE_URL is unset (local dev without Postgres). */
const memoryByWorkspace = new Map<string, SmartListRecord[]>();

function toSmartListRecord(row: typeof smartLists.$inferSelect): SmartListRecord {
  return { ...row, filters: row.filters as SearchFilters };
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
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    memoryLists(workspaceId).push(row);
    return row;
  }
  const [row] = await db
    .insert(smartLists)
    .values({ workspaceId, name, filters })
    .returning();
  return toSmartListRecord(row);
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

  return { list, hits, total: hits.length, demo };
}
