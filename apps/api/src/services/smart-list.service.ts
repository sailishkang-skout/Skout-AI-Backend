import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import {
  runSmartListQuery,
  type OpenSearchConfig,
  type SearchFilters,
} from "@skout/opensearch";

const { smartLists } = schema;

export async function listSmartLists(db: Db | null, workspaceId: string) {
  if (!db) return [];
  return db
    .select()
    .from(smartLists)
    .where(eq(smartLists.workspaceId, workspaceId))
    .orderBy(desc(smartLists.updatedAt));
}

export async function createSmartList(
  db: Db | null,
  workspaceId: string,
  name: string,
  filters: SearchFilters
) {
  if (!db) {
    return {
      id: crypto.randomUUID(),
      workspaceId,
      name,
      filters,
      lastRunCount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
  const [row] = await db
    .insert(smartLists)
    .values({ workspaceId, name, filters })
    .returning();
  return row;
}

export async function runSmartList(
  db: Db | null,
  osCfg: OpenSearchConfig,
  workspaceId: string,
  listId: string
) {
  if (!db) throw new Error("Database required");
  const [list] = await db
    .select()
    .from(smartLists)
    .where(eq(smartLists.id, listId));
  if (!list || list.workspaceId !== workspaceId) return null;

  const filters = list.filters as SearchFilters;
  const hits = await runSmartListQuery(osCfg, filters);
  await db
    .update(smartLists)
    .set({ lastRunCount: hits.length, updatedAt: new Date() })
    .where(eq(smartLists.id, listId));

  return { list, hits, total: hits.length };
}
