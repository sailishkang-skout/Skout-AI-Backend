import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { SheetMapping } from "./workbook-sheet-runner.js";

const { workbookSheetSources } = schema;

/** For a workbook copy with its rows: the copy pulls from the same tabs, and knows which rows it already has. */
export async function copySheetSources(tx: Db, fromWorkbookId: string, toWorkbookId: string, columnIds: ReadonlyMap<string, string>): Promise<void> {
  const sources = await tx.select().from(workbookSheetSources).where(eq(workbookSheetSources.workbookId, fromWorkbookId));
  const renamed = (id: string) => columnIds.get(id) ?? id;
  for (const source of sources) {
    const mapping = source.mapping as unknown as SheetMapping;
    const [copy] = await tx
      .insert(workbookSheetSources)
      .values({
        ...source,
        id: randomUUID(),
        workbookId: toWorkbookId,
        mapping: { ...mapping, columns: mapping.columns.map((c) => ({ ...c, columnId: renamed(c.columnId) })), identity: mapping.identity.map(renamed) },
        createdAt: undefined,
        updatedAt: undefined,
      })
      .returning({ id: workbookSheetSources.id });
    await tx.execute(sql`INSERT INTO workbook_sheet_keys (source_id, key) SELECT ${copy!.id}::uuid, key FROM workbook_sheet_keys WHERE source_id = ${source.id}::uuid`);
  }
}
