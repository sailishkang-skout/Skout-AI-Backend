import { and, asc, eq, gt, lte, max } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { dedupeValue, type MatchKey } from "./workbook-import-plan.js";

const { workbookRows, workbookCells } = schema;
const KEY_PAGE = 20_000;

/** The deduplication values already in the key column, brought up to date with rows added since the last look. */
export class KeyIndex {
  private readonly values = new Set<string>();
  private upToRowId = 0;

  constructor(
    private readonly workbookId: string,
    private readonly columnId: string,
    private readonly key: MatchKey
  ) {}

  has = (value: string) => this.values.has(value);
  add = (value: string) => this.values.add(value);

  async refresh(db: Db): Promise<void> {
    const [latest] = await db.select({ id: max(workbookRows.id) }).from(workbookRows).where(eq(workbookRows.workbookId, this.workbookId));
    const upTo = Number(latest?.id ?? 0);
    let after = this.upToRowId;
    while (after < upTo) {
      const cells = await db
        .select({ rowId: workbookCells.rowId, value: workbookCells.value })
        .from(workbookCells)
        .where(and(eq(workbookCells.workbookId, this.workbookId), eq(workbookCells.columnId, this.columnId), gt(workbookCells.rowId, after), lte(workbookCells.rowId, upTo)))
        .orderBy(asc(workbookCells.rowId))
        .limit(KEY_PAGE);
      for (const cell of cells) {
        const value = dedupeValue(this.key, String(cell.value ?? ""));
        if (value !== null) this.values.add(value);
      }
      if (cells.length < KEY_PAGE) break;
      after = cells[cells.length - 1]!.rowId;
    }
    this.upToRowId = Math.max(this.upToRowId, upTo);
  }
}
