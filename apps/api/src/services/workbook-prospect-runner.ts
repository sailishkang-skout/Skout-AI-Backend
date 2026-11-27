import { and, asc, count, eq, gt, inArray, max, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { ProspectDocument, SearchFilters } from "@skout/opensearch";
import { WorkbookV2Error, getWorkspaceRowLimit, lockLiveWorkbook, type WorkbookActor } from "./workbook-v2.service.js";
import { MAX_COLUMNS, addColumn } from "./workbook-v2-columns.service.js";
import { inputDataType, normalizeInputValue, type CellScalar, type InputDataType } from "./workbook-cell-values.js";
import { namedLike } from "./workbook-import-plan.js";
import { ImportStopped, Superseded, countsOf, lockImport, recordChunk, type Issue } from "./workbook-import-core.js";
import { getReusableContacts, type ReusableContact, type ReusableValue } from "./enrichment/contact-data.service.js";
import { snapshotFromCorpusDoc } from "../utils/verified-email.js";
import type { ProspectDirectory } from "./prospect-directory.js";
import { markRowSuppression } from "./workbook-suppression.service.js";

/**
 * Adds a selection of Skout prospects to a workbook (WB2-021): from a list, a smart list or Search.
 *
 * Every row keeps its `prospect_id`, and a prospect is added to a workbook once. A prospect must be one this workspace
 * already holds or one the shared search index has; one the index supplies becomes the workspace's prospect, as adding
 * it to a list does. Stored emails and phones are copied for free. Nothing here calls a provider or spends credits.
 */
const { workbookColumns, workbookRows, workbookImports, workbookImportItems, workbooks, prospectActivations, listMembers } = schema;

export const PROSPECT_CHUNK = 500;
const INSERT_CHUNK = 10_000;

export type ProspectSourceType = "list" | "smart_list" | "search";
type Field = "fullName" | "title" | "companyName" | "companyDomain" | "linkedinUrl" | "email" | "phone";

/** Where each fact about a person goes: a column with a matching name, or a new one. */
const FIELDS: Array<{ field: Field; name: string; dataType: InputDataType; accepts: InputDataType[]; operation?: string }> = [
  { field: "fullName", name: "Full name", dataType: "text", accepts: ["text"] },
  { field: "title", name: "Title", dataType: "text", accepts: ["text"] },
  { field: "companyName", name: "Company", dataType: "text", accepts: ["text"] },
  { field: "companyDomain", name: "Company domain", dataType: "domain", accepts: ["domain", "url", "text"] },
  { field: "linkedinUrl", name: "LinkedIn URL", dataType: "linkedin_url", accepts: ["linkedin_url", "url", "text"] },
  { field: "email", name: "Email", dataType: "email", accepts: ["email", "text"], operation: "find_email" },
  { field: "phone", name: "Phone", dataType: "phone", accepts: ["phone", "text"], operation: "find_phone" },
];

interface Target {
  columnId: string;
  type: "input" | "enrichment";
  dataType: InputDataType;
}

/** A confirmed addition, as stored on the import record. */
export interface ProspectPlan {
  source: { type: ProspectSourceType; id?: string; name?: string };
  /** A smart list's filters, used to check chosen people still match, or to read all who do. */
  filters?: SearchFilters;
  /** The whole smart list was asked for and has still to be read. */
  collect: boolean;
  /** The person picked individual prospects, so a smart list selection is checked against its filters. */
  chosen: boolean;
  background: boolean;
  /** Set when more matched than a workbook can hold. */
  truncated?: { matched: number; considered: number };
  /** Column headings of the skipped-rows report. */
  headers: string[];
  /** The column chosen for each fact, once one was needed. Null: the workbook has no room for it. */
  fields: Partial<Record<Field, Target | null>>;
  requestId: string | null;
}

type ImportRecord = typeof workbookImports.$inferSelect;
interface Person {
  fullName?: string;
  title?: string;
  companyName?: string;
  companyDomain?: string;
  linkedinUrl?: string;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const personOf = (known: Record<string, unknown> | undefined, doc: ProspectDocument | undefined): Person | null => {
  if (!known && !doc) return null;
  const pick = (key: keyof Person) => text(known?.[key]) ?? text(doc?.[key]);
  return { fullName: pick("fullName"), title: pick("title"), companyName: pick("companyName"), companyDomain: pick("companyDomain"), linkedinUrl: pick("linkedinUrl") };
};

export async function insertItems(db: Db, importId: string, prospectIds: string[]): Promise<void> {
  for (let i = 0; i < prospectIds.length; i += INSERT_CHUNK) {
    const slice = prospectIds.slice(i, i + INSERT_CHUNK).map((prospectId, j) => ({ seq: i + j + 1, prospect_id: prospectId }));
    await db.execute(sql`
      INSERT INTO workbook_import_items (import_id, seq, prospect_id)
      SELECT ${importId}::uuid, x.seq, x.prospect_id FROM jsonb_to_recordset(${JSON.stringify(slice)}::text::jsonb) AS x (seq int, prospect_id text)`);
  }
}

/** Reads everyone a smart list matches and fixes them as the selection, once. */
async function collectMatches(db: Db, directory: ProspectDirectory, workspaceId: string, record: ImportRecord): Promise<void> {
  const plan = record.plan as unknown as ProspectPlan;
  const limit = await getWorkspaceRowLimit(db, workspaceId);
  const ids = new Set<string>();
  for await (const batch of directory.matching(plan.filters ?? {}, limit)) {
    for (const id of batch) ids.add(id);
    // Shows the sweep that reading is still going on.
    await db.update(workbookImports).set({ updatedAt: sql`now()` }).where(eq(workbookImports.id, record.id));
  }
  const matched = ids.size >= limit ? await directory.count(plan.filters ?? {}) : ids.size;
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const current = await lockImport(tx, record.id);
    if (current?.status !== "processing" || !(current.plan as unknown as ProspectPlan).collect) throw new Superseded();
    await insertItems(tx, record.id, [...ids]);
    await tx
      .update(workbookImports)
      .set({
        counts: { ...countsOf(current.counts), total: ids.size },
        plan: { ...(current.plan as Record<string, unknown>), collect: false, ...(matched > ids.size ? { truncated: { matched, considered: ids.size } } : {}) },
        updatedAt: sql`now()`,
      })
      .where(eq(workbookImports.id, record.id));
  });
}

/** Chooses (or makes) the column for each fact these rows have, and checks the ones chosen earlier are still there. */
async function columnsFor(tx: Db, actor: WorkbookActor, workbookId: string, plan: ProspectPlan, needed: Set<Field>): Promise<boolean> {
  const columns: Array<{ id: string; name: string; type: string; operation: string | null; config: Record<string, unknown> }> = await tx
    .select({ id: workbookColumns.id, name: workbookColumns.name, type: workbookColumns.type, operation: workbookColumns.operation, config: workbookColumns.config })
    .from(workbookColumns)
    .where(eq(workbookColumns.workbookId, workbookId))
    .orderBy(asc(workbookColumns.position), asc(workbookColumns.id));
  let changed = false;
  for (const spec of FIELDS) {
    if (!needed.has(spec.field)) continue;
    const planned = plan.fields[spec.field];
    if (planned === null) continue;
    if (planned) {
      const column = columns.find((c) => c.id === planned.columnId);
      if (!column || column.type !== planned.type || (planned.type === "input" && inputDataType(column.config) !== planned.dataType)) {
        throw new ImportStopped("MAPPING_CHANGED", `The column for ${spec.name.toLowerCase()} was deleted or changed while rows were being added. Rows already added are in the workbook.`);
      }
      continue;
    }
    const used = new Set(Object.values(plan.fields).flatMap((t) => (t ? [t.columnId] : [])));
    const free = columns.filter((c) => !used.has(c.id));
    // An email or phone belongs in the column that would otherwise be run to find it.
    const enrichment = spec.operation ? free.find((c) => c.type === "enrichment" && c.operation === spec.operation) : undefined;
    const input = free.find((c) => c.type === "input" && namedLike(c.name, spec.name) && spec.accepts.includes(inputDataType(c.config)));
    const found = enrichment ?? input;
    if (found) {
      plan.fields[spec.field] = { columnId: found.id, type: found.type as Target["type"], dataType: found.type === "input" ? inputDataType(found.config) : spec.dataType };
    } else if (columns.length >= MAX_COLUMNS) {
      plan.fields[spec.field] = null;
    } else {
      const taken = (name: string) => columns.some((c) => c.name.trim().toLowerCase() === name.toLowerCase());
      let name = spec.name;
      for (let n = 2; taken(name); n++) name = `${spec.name} (${n})`;
      const created = await addColumn(tx, actor, workbookId, { name, type: "input", config: { dataType: spec.dataType } });
      columns.push({ id: created.data.id, name, type: "input", operation: null, config: { dataType: spec.dataType } });
      plan.fields[spec.field] = { columnId: created.data.id, type: "input", dataType: spec.dataType };
    }
    changed = true;
  }
  return changed;
}

interface NewCell {
  r: number;
  c: string;
  v: CellScalar;
  s: "found" | "error";
  e: string | null;
  f: "cache" | null;
  ver: string | null;
  p: Record<string, unknown> | null;
}

function cellFor(rowId: number, target: Target, raw: string, reuse: ReusableValue | null, field: Field): NewCell | null {
  const cell = normalizeInputValue(raw, target.dataType);
  if (cell.kind !== "value") return null;
  return {
    r: rowId,
    c: target.columnId,
    v: cell.value,
    s: cell.errorCode ? "error" : "found",
    e: cell.errorCode,
    // "From your Skout data": copied from what is stored, for no credits.
    f: reuse ? "cache" : null,
    ver: reuse && field === "email" ? reuse.verification : null,
    // SERVER ONLY: may name the provider that supplied the value.
    p: reuse ? { reused: true, ...reuse.provenance } : null,
  };
}

async function addChunk(db: Db, directory: ProspectDirectory, workspaceId: string, record: ImportRecord, items: Array<{ seq: number; prospectId: string }>): Promise<void> {
  const plan = record.plan as unknown as ProspectPlan;
  const ids = items.map((i) => i.prospectId);
  // Everything that may take a network call or a large read is gathered before the workbook is locked.
  const activations = await db
    .select({ prospectId: prospectActivations.prospectId, snapshot: prospectActivations.snapshot })
    .from(prospectActivations)
    .where(and(eq(prospectActivations.workspaceId, workspaceId), inArray(prospectActivations.prospectId, ids)));
  const known = new Map(activations.map((a) => [a.prospectId, (a.snapshot ?? {}) as Record<string, unknown>]));
  const docs = await directory.byIds(ids.filter((id) => !text(known.get(id)?.fullName)));
  let allowed: Set<string> | null = null;
  let notAllowed = "";
  if (plan.source.type === "list") {
    const members = await db.select({ prospectId: listMembers.prospectId }).from(listMembers).where(and(eq(listMembers.listId, plan.source.id!), inArray(listMembers.prospectId, ids)));
    allowed = new Set(members.map((m) => m.prospectId));
    notAllowed = "Not in this list";
  } else if (plan.source.type === "smart_list" && plan.chosen) {
    allowed = await directory.matchingAmong(plan.filters ?? {}, ids);
    notAllowed = "Does not match this smart list";
  }
  const contacts = await getReusableContacts(db, workspaceId, ids.filter((id) => known.has(id) || docs.has(id)));
  const actor: WorkbookActor = { workspaceId, userId: record.createdBy, requestId: plan.requestId ?? undefined };
  const source = JSON.stringify({
    type: plan.source.type,
    importId: record.id,
    addedAt: (record.confirmedAt ?? record.createdAt).toISOString(),
    ...(plan.source.type === "list" ? { listId: plan.source.id, listName: plan.source.name } : {}),
    ...(plan.source.type === "smart_list" ? { smartListId: plan.source.id, smartListName: plan.source.name } : {}),
  });

  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const current = await lockImport(tx, record.id);
    const counts = countsOf(current?.counts);
    if (current?.status !== "processing" || counts.processed !== items[0]!.seq - 1) throw new Superseded();
    try {
      await lockLiveWorkbook(tx, workspaceId, record.workbookId);
    } catch (error) {
      if (error instanceof WorkbookV2Error && error.code === "NOT_FOUND") throw new ImportStopped("WORKBOOK_DELETED", "The workbook was deleted while rows were being added.");
      throw error;
    }
    const present = await tx
      .select({ prospectId: workbookRows.prospectId })
      .from(workbookRows)
      .where(and(eq(workbookRows.workbookId, record.workbookId), inArray(workbookRows.prospectId, ids)));
    const inWorkbook = new Set(present.map((r) => r.prospectId));
    const limit = await getWorkspaceRowLimit(tx, workspaceId);
    const [rows] = await tx.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, record.workbookId));
    const existing = rows?.n ?? 0;

    const accepted: Array<{ prospectId: string; person: Person; reuse: ReusableContact }> = [];
    const issues: Issue[] = [];
    for (const item of items) {
      const person = personOf(known.get(item.prospectId), docs.get(item.prospectId));
      const report = (kind: Issue["kind"], reason: string) =>
        issues.push({ record: item.seq, line: item.seq, kind, reason, values: [item.prospectId, person?.fullName ?? "", person?.companyDomain ?? ""] });
      if (allowed && !allowed.has(item.prospectId)) report("skipped", notAllowed);
      else if (!person) report("skipped", "Prospect not found");
      else if (inWorkbook.has(item.prospectId)) report("duplicate", "Already in this workbook");
      else if (existing + accepted.length >= limit) report("over_limit", `The workbook reached its limit of ${limit.toLocaleString("en-US")} rows`);
      else accepted.push({ prospectId: item.prospectId, person, reuse: contacts.get(item.prospectId) ?? {} });
    }

    if (accepted.length) {
      const needed = new Set<Field>();
      for (const row of accepted) {
        for (const spec of FIELDS) {
          const value = spec.field === "email" || spec.field === "phone" ? row.reuse[spec.field]?.value : row.person[spec.field];
          if (value) needed.add(spec.field);
        }
      }
      if (await columnsFor(tx, actor, record.workbookId, plan, needed)) {
        await tx.update(workbookImports).set({ plan: plan as unknown as Record<string, unknown> }).where(eq(workbookImports.id, record.id));
      }

      // A prospect the search index supplied becomes this workspace's prospect. One it already holds is left as it is.
      const arriving = accepted.filter((row) => !known.has(row.prospectId));
      if (arriving.length) {
        await tx
          .insert(prospectActivations)
          .values(
            arriving.map((row) => {
              const doc = docs.get(row.prospectId)!;
              return { workspaceId, prospectId: row.prospectId, companyId: doc.companyId, snapshot: JSON.parse(JSON.stringify(snapshotFromCorpusDoc(doc))) as Record<string, unknown> };
            })
          )
          .onConflictDoNothing();
      }

      const [last] = await tx.select({ position: max(workbookRows.position) }).from(workbookRows).where(eq(workbookRows.workbookId, record.workbookId));
      const first = (last?.position ?? -1) + 1;
      const inserted = (await tx.execute(sql`
        INSERT INTO workbook_rows (workbook_id, position, source, prospect_id)
        SELECT ${record.workbookId}::uuid, x.position, ${source}::text::jsonb, x.prospect_id
        FROM jsonb_to_recordset(${JSON.stringify(accepted.map((row, i) => ({ position: first + i, prospect_id: row.prospectId })))}::text::jsonb) AS x (position int, prospect_id text)
        RETURNING id, position`)) as unknown as Array<{ id: string | number; position: number }>;
      const idAt = new Map(inserted.map((r) => [Number(r.position), Number(r.id)]));
      const cells = accepted.flatMap((row, i) =>
        FIELDS.flatMap(({ field }) => {
          const target = plan.fields[field];
          const reuse = field === "email" || field === "phone" ? (row.reuse[field] ?? null) : null;
          const value = field === "email" || field === "phone" ? reuse?.value : row.person[field];
          const cell = target && value ? cellFor(idAt.get(first + i)!, target, value, reuse, field) : null;
          return cell ? [cell] : [];
        })
      );
      if (cells.length) {
        await tx.execute(sql`
          INSERT INTO workbook_cells (workbook_id, row_id, column_id, value, state, error_code, found_via, verification, internal_provenance)
          SELECT ${record.workbookId}::uuid, x.r, x.c, x.v, x.s, x.e, x.f, x.ver, x.p
          FROM jsonb_to_recordset(${JSON.stringify(cells)}::text::jsonb) AS x (r bigint, c uuid, v jsonb, s text, e text, f text, ver text, p jsonb)`);
      }
      await markRowSuppression(tx, workspaceId, record.workbookId, [...idAt.values()]);
      await tx.update(workbooks).set({ rowCount: existing + accepted.length, updatedAt: sql`now()` }).where(eq(workbooks.id, record.workbookId));
    }
    await recordChunk(tx, record.id, counts, { processed: items.length, imported: accepted.length }, issues);
  });
}

/** Works through the selection from where it got to. The caller finishes the import. */
export async function addProspects(db: Db, directory: ProspectDirectory, workspaceId: string, claimed: ImportRecord): Promise<void> {
  const reload = async () => (await db.select().from(workbookImports).where(eq(workbookImports.id, claimed.id)))[0]!;
  let record = await reload();
  if ((record.plan as unknown as ProspectPlan).collect) await collectMatches(db, directory, workspaceId, record);
  for (;;) {
    record = await reload();
    const items = await db
      .select({ seq: workbookImportItems.seq, prospectId: workbookImportItems.prospectId })
      .from(workbookImportItems)
      .where(and(eq(workbookImportItems.importId, record.id), gt(workbookImportItems.seq, countsOf(record.counts).processed)))
      .orderBy(asc(workbookImportItems.seq))
      .limit(PROSPECT_CHUNK);
    if (!items.length) return;
    await addChunk(db, directory, workspaceId, record, items);
  }
}
