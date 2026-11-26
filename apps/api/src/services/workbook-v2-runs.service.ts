import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { WorkbookV2Error, findLiveWorkbook } from "./workbook-v2.service.js";

/**
 * Starting a column run or a CRM push (WB2-014). Only the checks exist: there is no execution engine yet (WB2-050),
 * so a permitted, well-formed request is answered "not implemented". Nothing is written, queued, sent or charged.
 * Whoever builds the engine replaces `notImplemented` and keeps the checks before it.
 */
const { workbookColumns } = schema;

/** Column types that are executed. Input columns hold typed data; formulas recompute by themselves, free (FX-2). */
const RUNNABLE_TYPES = new Set(["enrichment", "ai", "action"]);

export type RunKind = "run" | "crm_push";

/** The column to be run, once it is known to belong to a live workbook of this workspace and to be runnable. */
export async function findRunTarget(db: Db, workspaceId: string, workbookId: string, columnId: string, kind: RunKind) {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const [column] = await db
    .select({ id: workbookColumns.id, type: workbookColumns.type, operation: workbookColumns.operation })
    .from(workbookColumns)
    .where(and(eq(workbookColumns.workbookId, workbookId), eq(workbookColumns.id, columnId)))
    .limit(1);
  if (!column) throw new WorkbookV2Error("NOT_FOUND", 404, "Column not found");
  if (kind === "crm_push" && !(column.type === "action" && column.operation === "push_to_crm")) {
    throw new WorkbookV2Error("COLUMN_NOT_RUNNABLE", 422, "Only a Push to CRM column can push to a CRM.", { columnId: column.id, type: column.type, operation: column.operation });
  }
  if (!RUNNABLE_TYPES.has(column.type)) {
    throw new WorkbookV2Error("COLUMN_NOT_RUNNABLE", 422, `${column.type} columns are not run.`, { columnId: column.id, type: column.type });
  }
  return column;
}

export function notImplemented(kind: RunKind): never {
  throw new WorkbookV2Error("NOT_IMPLEMENTED", 501, kind === "run" ? "Running columns is not available yet." : "Pushing to a CRM is not available yet.");
}
