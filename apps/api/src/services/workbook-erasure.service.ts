/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (WB2-027 additions).
 *   - Tables touched directly: contacts - read only (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: an erasure finds everything the person is known by and removes their workbook rows in one transaction
 *     with the request's status; an HTTP call into apps/crm cannot take part in it.
 *   - Review date: 2026-11-27
 */
import { open } from "node:fs/promises";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";
import { recordWorkbookActivity, type ActivityActor } from "./workbook-activity-log.js";
import { csvLine, csvRecords, type CsvDelimiter } from "./workbook-import-csv.js";
import { saveStream, withTempFile, type ImportStorage } from "./workbook-import-storage.js";
import { cancelImport } from "./workbook-imports.service.js";
import { linkedinKey } from "./workbook-suppression.service.js";

/**
 * Removing one person from every workbook of a workspace (WB2-027, PRD SEC-8). It is part of the existing erasure
 * flows, not a flow of its own: completing a data subject erasure request, and enrichment's "Delete person".
 *
 * A row goes when it is linked to the person's prospect, holds their personal LinkedIn URL, or holds their email
 * address in an email column (or anywhere, if the row has no other address in an email column). Where a row is about
 * someone else and only mentions the address in another column, just that cell is cleared. Phone numbers and names do
 * not remove rows: both are often shared.
 *
 * Doing it again finds nothing and changes nothing.
 */
const { contacts, prospectActivations, enrichmentIdentities, workbooks, workbookImports, workbookRows } = schema;

const CHUNK = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Stands where an erased prospect was in the queue of an addition still being worked through. */
const ERASED = "erased";

export interface ErasureSubject {
  emails: string[];
  prospectIds: string[];
  /** LinkedIn identity keys, `in:<id>`. */
  linkedinKeys: string[];
}

const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((v): v is string => !!v))];
const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const list = (values: string[]) => sql`(SELECT x FROM jsonb_array_elements_text(${JSON.stringify(values)}::text::jsonb) AS x)`;

/** Everything the workspace knows a person by, from their address, a prospect or contact id, or both. */
export async function erasureSubject(db: Db, workspaceId: string, known: { email?: string; prospectId?: string; subjectId?: string | null }): Promise<ErasureSubject> {
  const email = lower(known.email);
  const prospect = known.prospectId ?? known.subjectId ?? "";
  const activationMatch: SQL[] = [];
  if (email) activationMatch.push(sql`lower(btrim(${prospectActivations.snapshot} ->> 'email')) = ${email}`);
  if (prospect) activationMatch.push(eq(prospectActivations.prospectId, prospect));
  const activations = activationMatch.length
    ? await db
        .select({ prospectId: prospectActivations.prospectId, email: sql<string | null>`${prospectActivations.snapshot} ->> 'email'` })
        .from(prospectActivations)
        .where(and(eq(prospectActivations.workspaceId, workspaceId), or(...activationMatch)))
    : [];
  const prospects = unique([known.prospectId, ...activations.map((a) => a.prospectId)]);

  const contactMatch: SQL[] = [];
  if (email) contactMatch.push(sql`lower(btrim(${contacts.email})) = ${email}`);
  if (prospects.length) contactMatch.push(inArray(contacts.sourceProspectId, prospects));
  if (prospect) contactMatch.push(eq(contacts.sourceProspectId, prospect));
  if (known.subjectId && UUID.test(known.subjectId)) contactMatch.push(eq(contacts.id, known.subjectId));
  const people = contactMatch.length
    ? await db
        .select({ id: contacts.id, email: contacts.email, prospectId: contacts.sourceProspectId, linkedinUrl: contacts.linkedinUrl })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, workspaceId), or(...contactMatch)))
    : [];
  const identities = people.length
    ? await db
        .select({ key: enrichmentIdentities.canonicalKey })
        .from(enrichmentIdentities)
        .where(and(eq(enrichmentIdentities.workspaceId, workspaceId), eq(enrichmentIdentities.entityType, "person"), inArray(enrichmentIdentities.entityId, people.map((p) => p.id))))
    : [];
  return {
    emails: unique([email, ...activations.map((a) => lower(a.email)), ...people.map((p) => lower(p.email))]),
    // A subject id that matched nothing may still be the prospect id on a row.
    prospectIds: unique([...prospects, ...people.map((p) => p.prospectId), known.subjectId]),
    linkedinKeys: unique([...identities.map((i) => i.key).filter((k) => k.startsWith("in:")), ...people.map((p) => (p.linkedinUrl ? linkedinKey(p.linkedinUrl) : null))]),
  };
}

const isEmpty = (s: ErasureSubject) => !s.emails.length && !s.prospectIds.length && !s.linkedinKeys.length;

interface Wanted {
  emails: Set<string>;
  keys: Set<string>;
  /** Prospect ids, which stored import records name people by. */
  ids?: Set<string>;
}

/** Whether one stored text names the person. */
function names(subject: Wanted, text: string): boolean {
  if (subject.emails.has(lower(text)) || subject.ids?.has(text.trim())) return true;
  const key = subject.keys.size ? linkedinKey(text) : null;
  return key !== null && subject.keys.has(key);
}

interface MatchedCell {
  row_id: string | number;
  column_id: string;
  value: unknown;
  /** Whether the column is one that holds email addresses. */
  email_column: boolean;
}

const EMAIL_COLUMN = sql`((col.type = 'input' AND col.config ->> 'dataType' = 'email') OR (col.type = 'enrichment' AND col.operation = 'find_email'))`;

/** The rows to remove from one workbook, and the cells to clear in rows that stay. */
async function matchesIn(db: Db, workbookId: string, subject: ErasureSubject): Promise<{ rows: number[]; cells: Array<{ rowId: number; columnId: string }> }> {
  const doomed = new Set<number>();
  if (subject.prospectIds.length) {
    const linked = await db
      .select({ id: workbookRows.id })
      .from(workbookRows)
      .where(and(eq(workbookRows.workbookId, workbookId), inArray(workbookRows.prospectId, subject.prospectIds)));
    for (const row of linked) doomed.add(row.id);
  }

  const conditions: SQL[] = [];
  if (subject.emails.length) {
    conditions.push(sql`lower(btrim(c.value #>> '{}')) IN ${list(subject.emails)}`);
    conditions.push(sql`EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(c.value) = 'object' THEN c.value ELSE '{}'::jsonb END) f WHERE lower(btrim(f.value)) IN ${list(subject.emails)})`);
  }
  // Narrowed by the id in the address, then confirmed with the identity rules.
  for (const key of subject.linkedinKeys) {
    const id = key.slice(3);
    for (const form of unique([id, encodeURIComponent(id)])) {
      conditions.push(sql`c.value::text ILIKE ${`%linkedin.com/in/${form.replace(/[\\%_]/g, "\\$&")}%`}`);
    }
  }
  const found = conditions.length
    ? ((await db.execute(sql`
        SELECT c.row_id, c.column_id, c.value, ${EMAIL_COLUMN} AS email_column
        FROM workbook_cells c JOIN workbook_columns col ON col.workbook_id = c.workbook_id AND col.id = c.column_id
        WHERE c.workbook_id = ${workbookId}::uuid AND (${sql.join(conditions, sql` OR `)})`)) as unknown as MatchedCell[])
    : [];

  const wanted = { emails: new Set(subject.emails), keys: new Set(subject.linkedinKeys) };
  const byAddress = new Map<number, Array<{ columnId: string; emailColumn: boolean }>>();
  for (const cell of found) {
    const rowId = Number(cell.row_id);
    const texts = typeof cell.value === "string" ? [cell.value] : cell.value && typeof cell.value === "object" ? Object.values(cell.value).filter((v): v is string => typeof v === "string") : [];
    const matched = texts.filter((t) => names(wanted, t));
    if (!matched.length) continue;
    if (matched.some((t) => linkedinKey(t) !== null)) doomed.add(rowId);
    else byAddress.set(rowId, [...(byAddress.get(rowId) ?? []), { columnId: cell.column_id, emailColumn: cell.email_column }]);
  }

  // A row that mentions the address outside its email columns, and has someone else's address in one, is about them.
  const elsewhere = [...byAddress].filter(([rowId, cells]) => !doomed.has(rowId) && cells.every((c) => !c.emailColumn)).map(([rowId]) => rowId);
  const aboutOthers = new Set<number>();
  for (let i = 0; i < elsewhere.length; i += CHUNK) {
    const others = (await db.execute(sql`
      SELECT DISTINCT c.row_id
      FROM workbook_cells c JOIN workbook_columns col ON col.workbook_id = c.workbook_id AND col.id = c.column_id
      WHERE c.workbook_id = ${workbookId}::uuid AND c.row_id IN (SELECT x::bigint FROM jsonb_array_elements_text(${JSON.stringify(elsewhere.slice(i, i + CHUNK))}::text::jsonb) AS x)
        AND ${EMAIL_COLUMN} AND c.value #>> '{}' LIKE '%@%'`)) as unknown as Array<{ row_id: string | number }>;
    for (const row of others) aboutOthers.add(Number(row.row_id));
  }
  const cells: Array<{ rowId: number; columnId: string }> = [];
  for (const [rowId, matched] of byAddress) {
    if (doomed.has(rowId)) continue;
    if (aboutOthers.has(rowId)) cells.push(...matched.map((c) => ({ rowId, columnId: c.columnId })));
    else doomed.add(rowId);
  }
  return { rows: [...doomed], cells };
}

export interface ErasureCounts {
  rowsRemoved: number;
  cellsCleared: number;
  workbooks: number;
}

/**
 * Removes the person's rows, with their cells, from every workbook of the workspace, deleted workbooks included, and
 * their lines from imports' working records. Must be called inside the caller's transaction, before it changes anything
 * else: every workbook of the workspace is locked, so no row arrives or changes while this runs.
 */
export async function eraseFromWorkbooks(tx: Db, actor: ActivityActor, subject: ErasureSubject): Promise<ErasureCounts> {
  const totals: ErasureCounts = { rowsRemoved: 0, cellsCleared: 0, workbooks: 0 };
  if (isEmpty(subject)) return totals;
  // In id order, so two erasures cannot each hold what the other wants.
  const books = await tx.select({ id: workbooks.id }).from(workbooks).where(eq(workbooks.workspaceId, actor.workspaceId)).orderBy(asc(workbooks.id)).for("no key update");
  for (const { id } of books) {
    const found = await matchesIn(tx, id, subject);
    for (let i = 0; i < found.cells.length; i += CHUNK) {
      const pairs = found.cells.slice(i, i + CHUNK).map((c) => ({ r: c.rowId, c: c.columnId }));
      await tx.execute(sql`
        DELETE FROM workbook_cells WHERE workbook_id = ${id}::uuid AND (row_id, column_id) IN
          (SELECT x.r, x.c FROM jsonb_to_recordset(${JSON.stringify(pairs)}::text::jsonb) AS x (r bigint, c uuid))`);
    }
    for (let i = 0; i < found.rows.length; i += CHUNK) {
      await tx.delete(workbookRows).where(and(eq(workbookRows.workbookId, id), inArray(workbookRows.id, found.rows.slice(i, i + CHUNK))));
    }
    if (!found.rows.length && !found.cells.length) continue;
    totals.rowsRemoved += found.rows.length;
    totals.cellsCleared += found.cells.length;
    totals.workbooks += 1;
    if (found.rows.length) {
      const [left] = (await tx.execute(sql`
        UPDATE workbooks SET row_count = (SELECT count(*) FROM workbook_rows WHERE workbook_id = ${id}::uuid), updated_at = now()
        WHERE id = ${id}::uuid RETURNING row_count`)) as unknown as Array<{ row_count: number }>;
      await recordWorkbookActivity(tx, actor, id, { action: "workbook.rows.delete", after: { deleted: found.rows.length, rowCount: Number(left!.row_count) } });
    }
  }

  const ids = books.map((b) => b.id);
  if (ids.length) {
    const imports = sql`(SELECT id FROM workbook_imports WHERE workbook_id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb) AS x))`;
    const mentioned = unique([...subject.emails, ...subject.prospectIds.map((p) => p.toLowerCase())]);
    if (mentioned.length) {
      await tx.execute(sql`
        DELETE FROM workbook_import_issues i WHERE i.import_id IN ${imports}
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(i."values") v WHERE lower(btrim(v)) IN ${list(mentioned)})`);
    }
    // Kept in place, so an addition under way keeps its count; it reports the place as not found.
    if (subject.prospectIds.length) {
      await tx.execute(sql`UPDATE workbook_import_items SET prospect_id = ${ERASED} WHERE import_id IN ${imports} AND prospect_id IN ${list(subject.prospectIds)}`);
    }
  }
  return totals;
}

export interface ImportFileCounts {
  reportsCleaned: number;
  previewsCancelled: number;
}

/** Whether a stored CSV names the person; with `keep`, writes the records that don't to that file. */
async function readFile(file: string, delimiter: CsvDelimiter, subject: Wanted, keep?: string): Promise<boolean> {
  const out = keep ? await open(keep, "w", 0o600) : null;
  let named = false;
  try {
    if (out) await out.write("\uFEFF");
    for await (const record of csvRecords(file, delimiter)) {
      if (record.values.some((v) => names(subject, v))) {
        named = true;
        if (!out) return true;
      } else if (out) await out.write(csvLine(record.values));
    }
  } finally {
    await out?.close();
  }
  return named;
}

/** Whether any text anywhere in a stored preview names the person. */
function holds(value: unknown, subject: Wanted): boolean {
  if (typeof value === "string") return names(subject, value);
  return !!value && typeof value === "object" && Object.values(value).some((v) => holds(v, subject));
}

/**
 * Takes the person out of what imports have kept: their lines leave skipped-row reports, and an upload still waiting
 * to be confirmed that holds them is cancelled and removed. Files cannot be part of a database transaction, so this is
 * done first; it throws if a file cannot be dealt with, and can be run again.
 *
 * An import already confirmed and still running is left to finish: what it adds is marked suppressed if the person is.
 */
export async function eraseFromImportFiles(db: Db, storage: ImportStorage | null, workspaceId: string, subject: ErasureSubject): Promise<ImportFileCounts> {
  const totals: ImportFileCounts = { reportsCleaned: 0, previewsCancelled: 0 };
  if (!storage || isEmpty(subject)) return totals;
  const wanted: Wanted = { emails: new Set(subject.emails), keys: new Set(subject.linkedinKeys), ids: new Set(subject.prospectIds) };
  const found = await db
    .select({ id: workbookImports.id, workbookId: workbookImports.workbookId, status: workbookImports.status, fileKey: workbookImports.fileKey, report: workbookImports.errorReportFile, preview: workbookImports.preview })
    .from(workbookImports)
    .innerJoin(workbooks, eq(workbooks.id, workbookImports.workbookId))
    .where(and(eq(workbooks.workspaceId, workspaceId), sql`(${workbookImports.status} = 'awaiting_confirmation' OR ${workbookImports.errorReportFile} IS NOT NULL)`));

  for (const item of found) {
    if (item.report) {
      const stored = await storage.open(item.report);
      if (stored) {
        await withTempFile(async (file) => {
          await saveStream(stored, file);
          if (!(await readFile(file, ",", wanted))) return;
          await withTempFile(async (kept) => {
            await readFile(file, ",", wanted, kept);
            await storage.put(item.report!, kept);
          });
          totals.reportsCleaned += 1;
        });
      }
    }
    if (item.status !== "awaiting_confirmation") continue;
    const preview = item.preview as { delimiter?: CsvDelimiter } | null;
    let named = false;
    const upload = item.fileKey ? await storage.open(item.fileKey) : null;
    if (upload) {
      named = await withTempFile(async (file) => {
        await saveStream(upload, file);
        return readFile(file, preview?.delimiter ?? ",", wanted);
      });
    }
    if (named || holds(item.preview, wanted)) {
      await cancelImport(db, storage, workspaceId, item.workbookId, item.id);
      totals.previewsCancelled += 1;
    }
  }
  return totals;
}

/** Counts of what an erasure removed, in the audit log. Nothing about who it was. */
export async function auditErasure(db: Db, actor: ActivityActor & { userId: string }, source: { type: "dsar_request" | "person"; id: string }, counts: ErasureCounts & ImportFileCounts): Promise<void> {
  await writeCopsAudit(db, {
    tenantId: actor.workspaceId,
    actor: { type: "user", id: actor.userId },
    entityType: source.type,
    entityId: source.id,
    action: "workbook.person.erased",
    after: { ...counts },
    correlationId: actor.requestId || source.id,
    sourceChannel: "api",
  });
}
