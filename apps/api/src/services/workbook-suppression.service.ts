import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { findOptedOut, isEmailAddress, phoneDigits, type PersonIdentifier } from "./cops-can-contact.js";
import { personPublicKey, publicIdFromProfileUrl } from "./enrichment/capture-identity.js";

/**
 * Suppression in Workbooks V2 (WB2-027, PRD ROW-11 and SEC-8). A suppressed or opted-out person is imported like
 * anyone else and their row is marked. Nothing that runs a column may do anything for such a row.
 *
 * Who has opted out is decided by the contact gate (`findOptedOut`); this reads the identifiers a row holds. A row is
 * matched on its linked prospect and on the email addresses, phone numbers and personal LinkedIn URLs in its input and
 * enrichment cells. A row holding none of these, such as a company, is not matched: no person is guessed from it.
 */
const { workbookRows, workbookCells, workbookColumns } = schema;

const CHUNK = 2_000;
/** The reason a skipped cell carries. */
export const SUPPRESSED_REASON = "suppressed";

/** The identity key of a personal LinkedIn URL, however it was typed; null for anything else. */
export function linkedinKey(value: string): string | null {
  const text = value.trim();
  if (!/linkedin\.com\/in\//i.test(text)) return null;
  const address = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "");
  const id = publicIdFromProfileUrl(`https://${address.replace(/^[a-z]{2,3}\.linkedin\.com/i, "www.linkedin.com").replace(/^(www\.)?linkedin\.com/i, "www.linkedin.com")}`);
  return id ? personPublicKey(id) : null;
}

/** The text values in a cell, including those of a cell that holds several named fields. */
function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).filter((v): v is string => typeof v === "string");
  return [];
}

/** What identifies a person in one value. Phone numbers are read only where a column says it holds them. */
export function identifiersIn(ref: number, value: unknown, holdsPhone: boolean): PersonIdentifier[] {
  return textsOf(value).flatMap((text): PersonIdentifier[] => {
    const trimmed = text.trim();
    if (isEmailAddress(trimmed)) return [{ ref, kind: "email", value: trimmed.toLowerCase() }];
    const profile = linkedinKey(trimmed);
    if (profile) return [{ ref, kind: "linkedin", value: profile }];
    const phone = holdsPhone ? phoneDigits(trimmed) : null;
    return phone ? [{ ref, kind: "phone", value: phone }] : [];
  });
}

/** Which of these rows of one workbook belong to someone who has opted out, read from the records as they are now. */
async function optedOutRows(db: Db, workspaceId: string, workbookId: string, rowIds: number[]): Promise<Set<number>> {
  const rows = await db
    .select({ id: workbookRows.id, prospectId: workbookRows.prospectId, crmRef: workbookRows.crmRef })
    .from(workbookRows)
    .where(and(eq(workbookRows.workbookId, workbookId), inArray(workbookRows.id, rowIds)));
  const cells = await db
    .select({ rowId: workbookCells.rowId, value: workbookCells.value, type: workbookColumns.type, operation: workbookColumns.operation, config: workbookColumns.config })
    .from(workbookCells)
    .innerJoin(workbookColumns, and(eq(workbookColumns.workbookId, workbookCells.workbookId), eq(workbookColumns.id, workbookCells.columnId)))
    .where(and(eq(workbookCells.workbookId, workbookId), inArray(workbookCells.rowId, rowIds), inArray(workbookColumns.type, ["input", "enrichment"])));
  // A CRM company record is a company: its switchboard number doesn't make it a person.
  const companies = new Set(rows.filter((r) => (r.crmRef as { object?: unknown } | null)?.object === "company").map((r) => r.id));
  const identifiers: PersonIdentifier[] = rows.flatMap((r) => (r.prospectId ? [{ ref: r.id, kind: "prospect" as const, value: r.prospectId }] : []));
  for (const cell of cells) {
    const holdsPhone = !companies.has(cell.rowId) && (cell.type === "input" ? (cell.config as { dataType?: unknown }).dataType === "phone" : cell.operation === "find_phone");
    identifiers.push(...identifiersIn(cell.rowId, cell.value, holdsPhone));
  }
  return findOptedOut(db, workspaceId, identifiers);
}

/**
 * Sets each row's `suppressed` mark to what the records say now. Called by everything that adds rows or changes their
 * values, inside the same transaction. Returns the rows that are suppressed.
 */
export async function markRowSuppression(db: Db, workspaceId: string, workbookId: string, rowIds: number[]): Promise<Set<number>> {
  const found = new Set<number>();
  for (let i = 0; i < rowIds.length; i += CHUNK) {
    const chunk = rowIds.slice(i, i + CHUNK);
    const out = await optedOutRows(db, workspaceId, workbookId, chunk);
    const marked = [...out];
    marked.forEach((id) => found.add(id));
    const isOut = marked.length ? inArray(workbookRows.id, marked) : sql`false`;
    await db
      .update(workbookRows)
      .set({ suppressed: sql`${isOut}` })
      .where(and(eq(workbookRows.workbookId, workbookId), inArray(workbookRows.id, chunk), sql`${workbookRows.suppressed} IS DISTINCT FROM (${isOut})`));
  }
  return found;
}
