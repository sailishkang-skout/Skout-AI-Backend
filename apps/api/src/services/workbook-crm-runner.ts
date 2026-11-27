import { count, eq, max, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { WorkbookV2Error, getWorkspaceRowLimit, lockLiveWorkbook } from "./workbook-v2.service.js";
import { inputDataType } from "./workbook-cell-values.js";
import { classifyRow, duplicateReason, type ClassifiedRow, type ImportPlan, type MatchKey } from "./workbook-import-plan.js";
import { ImportStopped, RetryLater, Superseded, countsOf, lockImport, recordChunk, type Issue } from "./workbook-import-core.js";
import { KeyIndex } from "./workbook-import-keys.js";
import { crmMessage, type CrmAccess, type CrmSession } from "./workbook-crm-access.js";
import { CrmSourceError, type CrmPage, type CrmRecordSource } from "./crm-record-source.js";
import type { CrmPlan } from "./workbook-crm.service.js";

/**
 * Does a confirmed CRM import (WB2-023).
 *
 * Records are read page by page and added in chunks. Each chunk is one transaction that adds its rows, records those it
 * did not add, moves `processed` past them and saves where the next page starts, so a retry carries on exactly there.
 * A record already in the workbook (by its `crm_ref`) is never added again, whatever is retried or repeated. The CRM is
 * read outside the transaction, so the workbook is locked only while a chunk is written.
 */
const { workbooks, workbookColumns, workbookRows, workbookImports } = schema;

export const CRM_PAGE = 100;
export const CRM_CHUNK = 500;
const CELL_CHUNK = 20_000;

export type CrmImportPlan = ImportPlan & { crm: CrmPlan };

/** What a person is told when a CRM import cannot continue. */
export const crmFailureMessage = (failure: CrmSourceError["failure"], label: string) =>
  `${crmMessage(failure, label)} Rows already imported are in the workbook; importing again skips them.`;

const STOPPED: Partial<Record<CrmSourceError["failure"], string>> = {
  not_connected: "CRM_NOT_CONNECTED",
  reauth: "CRM_RECONNECT_REQUIRED",
  scope: "CRM_SCOPE_MISSING",
  not_found: "CRM_VIEW_NOT_FOUND",
  rejected: "CRM_QUERY_REJECTED",
};

interface Run {
  importId: string;
  workspaceId: string;
  workbookId: string;
  plan: CrmImportPlan;
  /** Stored on every imported row (PRD ROW-9). */
  source: string;
  keys: KeyIndex | null;
}

/** One read from the CRM, with what could go wrong put into the import's own terms. */
async function fromCrm<T>(access: CrmAccess, run: Run, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof CrmSourceError)) throw error;
    const { provider, providerLabel } = run.plan.crm;
    if (error.retryable) throw new RetryLater(error.failure === "rate_limited" ? "CRM_RATE_LIMITED" : "CRM_UNAVAILABLE", crmFailureMessage(error.failure, providerLabel));
    if (error.failure === "reauth") await access.expired(run.workspaceId, provider);
    throw new ImportStopped(STOPPED[error.failure]!, crmFailureMessage(error.failure, providerLabel));
  }
}

/** Reads whole pages until there is a chunk's worth or no more. Nothing of a page is saved without the rest of it. */
async function readChunk(access: CrmAccess, source: CrmRecordSource, run: Run, session: CrmSession, from: string | null) {
  const entries: Array<{ id: string; values: string[] | null }> = [];
  let cursor = from;
  for (;;) {
    const page: CrmPage = await fromCrm(access, run, () => source.page(session.accessToken, run.plan.crm.query, cursor, CRM_PAGE));
    for (const { id, properties } of page.records) entries.push({ id, values: properties && run.plan.crm.query.fields.map((f) => properties[f] ?? "") });
    // A CRM that hands back the same empty page again would never end.
    const stuck = !page.records.length && page.next === cursor;
    cursor = stuck ? null : page.next;
    if (cursor === null || entries.length >= CRM_CHUNK) return { entries, next: cursor };
  }
}

async function checkColumns(tx: Db, run: Run) {
  const found = await tx.select({ id: workbookColumns.id, type: workbookColumns.type, config: workbookColumns.config }).from(workbookColumns).where(eq(workbookColumns.workbookId, run.workbookId));
  const byId = new Map(found.map((c) => [c.id, c]));
  for (const planned of run.plan.columns) {
    const column = byId.get(planned.columnId);
    if (!column || column.type !== "input" || inputDataType(column.config) !== planned.dataType) {
      throw new ImportStopped("MAPPING_CHANGED", `The column “${planned.name}” was deleted or its type changed while the import was running. Rows already imported are in the workbook.`);
    }
  }
}

/** Which of these records the workbook already holds a row for. */
async function alreadyHere(tx: Db, run: Run, ids: string[]): Promise<Set<string>> {
  const { provider, object, accountId } = run.plan.crm;
  if (!ids.length) return new Set();
  const found = (await tx.execute(sql`
    SELECT crm_ref ->> 'id' AS id FROM workbook_rows
    WHERE workbook_id = ${run.workbookId}::uuid AND crm_ref ->> 'provider' = ${provider} AND coalesce(crm_ref ->> 'accountId', '') = ${accountId}
      AND crm_ref ->> 'object' = ${object} AND crm_ref ->> 'id' IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb))`)) as unknown as Array<{ id: string }>;
  return new Set(found.map((r) => r.id));
}

/** Adds one chunk. Answers whether there is more to read. */
async function importChunk(db: Db, run: Run, expected: number, chunk: { entries: Array<{ id: string; values: string[] | null }>; next: string | null }): Promise<boolean> {
  const { newKeys, more } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const current = await lockImport(tx, run.importId);
    const counts = countsOf(current?.counts);
    if (current?.status !== "processing" || counts.processed !== expected) throw new Superseded();
    try {
      await lockLiveWorkbook(tx, run.workspaceId, run.workbookId);
    } catch (error) {
      if (error instanceof WorkbookV2Error && error.code === "NOT_FOUND") throw new ImportStopped("WORKBOOK_DELETED", "The workbook was deleted while the import was running.");
      throw error;
    }
    await checkColumns(tx, run);
    await run.keys?.refresh(tx);

    const limit = await getWorkspaceRowLimit(tx, run.workspaceId);
    const [rows] = await tx.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, run.workbookId));
    const existing = rows?.n ?? 0;
    const here = await alreadyHere(tx, run, chunk.entries.map((e) => e.id));

    const accepted: Array<Extract<ClassifiedRow, { kind: "ready" }> & { id: string }> = [];
    const issues: Issue[] = [];
    const keys = new Set<string>();
    const seen = new Set<string>();
    let full = false;
    chunk.entries.forEach((entry, i) => {
      const record = expected + i + 1;
      // The report names the CRM record first, then what was read from it.
      const report = (kind: Issue["kind"], reason: string) => issues.push({ record, line: record, kind, reason, values: [entry.id, ...(entry.values ?? [])] });
      if (entry.values === null) return report("skipped", `No longer in ${run.plan.crm.providerLabel}`);
      if (here.has(entry.id) || seen.has(entry.id)) return report("duplicate", "This record is already in the workbook");
      seen.add(entry.id);
      const outcome = classifyRow(run.plan, entry.values);
      if (outcome.kind !== "ready") return report(outcome.kind, outcome.reason);
      if (outcome.key !== null && (keys.has(outcome.key) || run.keys!.has(outcome.key))) return report("duplicate", duplicateReason((run.plan.dedupe as { key: MatchKey }).key));
      if (existing + accepted.length >= limit) {
        full = true;
        return report("over_limit", `The workbook reached its limit of ${limit.toLocaleString("en-US")} rows`);
      }
      accepted.push({ ...outcome, id: entry.id });
      if (outcome.key !== null) keys.add(outcome.key);
    });

    if (accepted.length) {
      const [last] = await tx.select({ position: max(workbookRows.position) }).from(workbookRows).where(eq(workbookRows.workbookId, run.workbookId));
      const first = (last?.position ?? -1) + 1;
      const { provider, object, accountId } = run.plan.crm;
      const made = accepted.map((row, i) => ({ p: first + i, ref: { provider, object, id: row.id, accountId } }));
      const inserted = (await tx.execute(sql`
        INSERT INTO workbook_rows (workbook_id, position, source, crm_ref)
        SELECT ${run.workbookId}::uuid, x.p, ${run.source}::text::jsonb, x.ref
        FROM jsonb_to_recordset(${JSON.stringify(made)}::text::jsonb) AS x (p int, ref jsonb)
        RETURNING id, position`)) as unknown as Array<{ id: string | number; position: number }>;
      const idAt = new Map(inserted.map((r) => [Number(r.position), Number(r.id)]));
      const cells = accepted.flatMap((row, i) => row.cells.map((cell) => ({ r: idAt.get(first + i)!, c: cell.columnId, v: cell.value })));
      for (let i = 0; i < cells.length; i += CELL_CHUNK) {
        await tx.execute(sql`
          INSERT INTO workbook_cells (workbook_id, row_id, column_id, value, state)
          SELECT ${run.workbookId}::uuid, x.r, x.c, x.v, 'found'
          FROM jsonb_to_recordset(${JSON.stringify(cells.slice(i, i + CELL_CHUNK))}::text::jsonb) AS x (r bigint, c uuid, v jsonb)`);
      }
      await tx.update(workbooks).set({ rowCount: existing + accepted.length, updatedAt: sql`now()` }).where(eq(workbooks.id, run.workbookId));
    }

    const processed = counts.processed + chunk.entries.length;
    // Reading further once the workbook is full would only list what does not fit.
    const stop = full && chunk.next !== null;
    const done = chunk.next === null || stop;
    // The CRM's count is an estimate: the total is corrected to what is really read.
    const total = done ? processed : Math.max(counts.total, processed + 1);
    await recordChunk(tx, run.importId, { ...counts, total }, { processed: chunk.entries.length, imported: accepted.length }, issues);
    const crm: CrmPlan = {
      ...run.plan.crm,
      cursor: chunk.next,
      done,
      ...(stop ? { truncated: { matched: Math.max(run.plan.crm.matched ?? 0, processed), considered: processed } } : {}),
    };
    await tx.update(workbookImports).set({ plan: { ...run.plan, crm } as unknown as Record<string, unknown> }).where(eq(workbookImports.id, run.importId));
    run.plan = { ...run.plan, crm };
    return { newKeys: keys, more: !done };
  });
  for (const key of newKeys) run.keys?.add(key);
  return more;
}

/** Works through a CRM import from where it last stopped. */
export async function importFromCrm(db: Db, access: CrmAccess, workspaceId: string, record: typeof workbookImports.$inferSelect): Promise<void> {
  const plan = record.plan as unknown as CrmImportPlan;
  const source = access.source(plan.crm.provider);
  if (!source) throw new ImportStopped("CRM_NOT_AVAILABLE", `Importing from ${plan.crm.providerLabel} isn't available.`);
  if (plan.crm.done) return;
  const importedAt = (record.confirmedAt ?? record.createdAt).toISOString();
  const run: Run = {
    importId: record.id,
    workspaceId,
    workbookId: record.workbookId,
    plan,
    source: JSON.stringify({
      type: plan.crm.provider,
      object: plan.crm.object,
      importId: record.id,
      importedAt,
      ...(plan.crm.query.viewId === undefined ? {} : { viewId: plan.crm.query.viewId, viewName: plan.crm.viewName }),
      ...(plan.crm.query.filters.length ? { filtered: true } : {}),
    }),
    keys: plan.dedupe.key === "none" ? null : new KeyIndex(record.workbookId, plan.dedupe.columnId, plan.dedupe.key),
  };
  // The long first read happens before any lock is taken.
  await run.keys?.refresh(db);
  let processed = countsOf(record.counts).processed;
  for (;;) {
    // Fetched afresh for each chunk, so a long import refreshes its token as it goes.
    const session = await fromCrm(access, run, () => access.open(workspaceId, plan.crm.provider));
    if (session.accountId !== plan.crm.accountId) {
      throw new ImportStopped("CRM_ACCOUNT_CHANGED", `${plan.crm.providerLabel} was reconnected to a different account during the import, so it stopped. Rows already imported are in the workbook.`);
    }
    const chunk = await readChunk(access, source, run, session, run.plan.crm.cursor);
    const more = await importChunk(db, run, processed, chunk);
    processed += chunk.entries.length;
    if (!more) return;
  }
}
