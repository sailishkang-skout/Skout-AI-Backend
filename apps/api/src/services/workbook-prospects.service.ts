import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { schema, scopedById, type Db } from "@skout/db";
import type { SearchFilters } from "@skout/opensearch";
import { WorkbookV2Error, findLiveWorkbook, getWorkspaceRowLimit, type WorkbookActor } from "./workbook-v2.service.js";
import { ImportFailure } from "./workbook-import-core.js";
import { SYNC_ROW_LIMIT, assertRoomForAnotherImport, getImport, startImport, type ImportDto } from "./workbook-imports.service.js";
import { insertItems, type ProspectPlan, type ProspectSourceType } from "./workbook-prospect-runner.js";
import { SEARCH_WINDOW, type ProspectDirectory } from "./prospect-directory.js";
import type { ImportQueue } from "./workbook-import-runner.js";
import type { ImportStorage } from "./workbook-import-storage.js";

/**
 * Choosing Skout prospects for a workbook (WB2-021): browsing a list or smart list, and starting an addition from a
 * list, a smart list or a Search selection. Lists, smart lists and workbooks are always looked up in the session's
 * workspace; the addition itself is done by the import runner.
 */
const { workbookRows, workbookImports, lists, listMembers, smartLists, prospectActivations } = schema;

/** The most individual prospects one request may name. A whole list or smart list is asked for with `all`. */
export const MAX_CHOSEN = 10_000;

export type SourceChoice = { type: "list"; listId: string } | { type: "smart_list"; smartListId: string } | { type: "search" };
export type Selection = { prospectIds: string[] } | { all: true };

export interface SourceProspect {
  prospectId: string;
  fullName: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  inWorkbook: boolean;
}

export interface SourcePage {
  source: { type: "list" | "smart_list"; id: string; name: string };
  data: SourceProspect[];
  total: number;
  page: number;
  pageSize: number;
}

const searchUnavailable = () => new WorkbookV2Error("SEARCH_UNAVAILABLE", 503, "Prospect search is unavailable right now. Try again in a moment.");

/** A search index that fails is reported as unavailable, never as "no matches". */
async function fromSearch<T>(directory: ProspectDirectory, work: () => Promise<T>): Promise<T> {
  if (!directory.available) throw searchUnavailable();
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkbookV2Error) throw error;
    throw searchUnavailable();
  }
}

async function findList(db: Db, workspaceId: string, listId: string) {
  const [list] = await db.select({ id: lists.id, name: lists.name }).from(lists).where(scopedById(lists, workspaceId, listId)).limit(1);
  return list ?? null;
}

async function findSmartList(db: Db, workspaceId: string, smartListId: string) {
  const [list] = await db
    .select({ id: smartLists.id, name: smartLists.name, filters: smartLists.filters })
    .from(smartLists)
    .where(and(eq(smartLists.id, smartListId), eq(smartLists.workspaceId, workspaceId)))
    .limit(1);
  return list ? { ...list, filters: list.filters as SearchFilters } : null;
}

async function presentIn(db: Db, workbookId: string, prospectIds: string[]): Promise<Set<string | null>> {
  if (!prospectIds.length) return new Set();
  const rows = await db
    .select({ prospectId: workbookRows.prospectId })
    .from(workbookRows)
    .where(and(eq(workbookRows.workbookId, workbookId), inArray(workbookRows.prospectId, prospectIds)));
  return new Set(rows.map((r) => r.prospectId));
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
/** Only who the person is: contact details are never listed here. */
const described = (prospectId: string, known: Record<string, unknown> | undefined, inWorkbook: boolean): SourceProspect => ({
  prospectId,
  fullName: str(known?.fullName),
  title: str(known?.title),
  companyName: str(known?.companyName),
  companyDomain: str(known?.companyDomain),
  inWorkbook,
});

export async function listProspects(db: Db, directory: ProspectDirectory, workspaceId: string, workbookId: string, listId: string, page: number, pageSize: number): Promise<SourcePage> {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const list = await findList(db, workspaceId, listId);
  if (!list) throw new WorkbookV2Error("NOT_FOUND", 404, "List not found");
  const [total] = await db.select({ n: count() }).from(listMembers).where(eq(listMembers.listId, list.id));
  const members = await db
    .select({ prospectId: listMembers.prospectId, snapshot: prospectActivations.snapshot })
    .from(listMembers)
    .leftJoin(prospectActivations, and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, listMembers.prospectId)))
    .where(eq(listMembers.listId, list.id))
    .orderBy(asc(listMembers.addedAt), asc(listMembers.prospectId))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const ids = members.map((m) => m.prospectId);
  const present = await presentIn(db, workbookId, ids);
  // Names for members the workspace holds no details of. Without search they are listed by id.
  const unnamed = members.filter((m) => !str((m.snapshot as Record<string, unknown> | null)?.fullName)).map((m) => m.prospectId);
  const docs = unnamed.length && directory.available ? await directory.byIds(unnamed).catch(() => new Map()) : new Map();
  return {
    source: { type: "list", id: list.id, name: list.name },
    data: members.map((m) => described(m.prospectId, { ...docs.get(m.prospectId), ...((m.snapshot as Record<string, unknown> | null) ?? {}) }, present.has(m.prospectId))),
    total: total?.n ?? 0,
    page,
    pageSize,
  };
}

export async function smartListProspects(db: Db, directory: ProspectDirectory, workspaceId: string, workbookId: string, smartListId: string, page: number, pageSize: number): Promise<SourcePage> {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const list = await findSmartList(db, workspaceId, smartListId);
  if (!list) throw new WorkbookV2Error("NOT_FOUND", 404, "Smart list not found");
  if (page * pageSize > SEARCH_WINDOW) {
    throw new WorkbookV2Error("PAGE_OUT_OF_RANGE", 422, `Only the first ${SEARCH_WINDOW.toLocaleString("en-US")} matches can be browsed. Add all matches, or narrow the smart list.`);
  }
  const found = await fromSearch(directory, () => directory.page(list.filters, page, pageSize));
  const present = await presentIn(db, workbookId, found.hits.map((h) => h.prospectId));
  return {
    source: { type: "smart_list", id: list.id, name: list.name },
    data: found.hits.map((h) => described(h.prospectId, h as unknown as Record<string, unknown>, present.has(h.prospectId))),
    total: found.total,
    page,
    pageSize,
  };
}

/** Starts adding the chosen prospects to a workbook: at once up to 1,000, otherwise in the background. */
export async function addProspectsToWorkbook(
  db: Db,
  deps: { storage: ImportStorage; queue: ImportQueue; directory: ProspectDirectory },
  actor: WorkbookActor,
  workbookId: string,
  choice: { source: SourceChoice; selection: Selection }
): Promise<{ background: boolean; data: ImportDto }> {
  await findLiveWorkbook(db, actor.workspaceId, workbookId);
  const { source } = choice;
  const chosen = "prospectIds" in choice.selection ? [...new Set(choice.selection.prospectIds)] : null;
  if (!chosen && source.type === "search") throw new WorkbookV2Error("UNKNOWN_SOURCE", 422, "Choose the prospects to add from Search.");

  let named: { id?: string; name?: string } = {};
  let filters: SearchFilters | undefined;
  if (source.type === "list") {
    const list = await findList(db, actor.workspaceId, source.listId);
    if (!list) throw new WorkbookV2Error("UNKNOWN_SOURCE", 422, "List not found");
    named = { id: list.id, name: list.name };
  } else if (source.type === "smart_list") {
    const list = await findSmartList(db, actor.workspaceId, source.smartListId);
    if (!list) throw new WorkbookV2Error("UNKNOWN_SOURCE", 422, "Smart list not found");
    named = { id: list.id, name: list.name };
    filters = list.filters;
  }
  if (source.type !== "list" && !deps.directory.available) throw searchUnavailable();

  await assertRoomForAnotherImport(db, actor.workspaceId);
  const limit = await getWorkspaceRowLimit(db, actor.workspaceId);
  const [rows] = await db.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, workbookId));
  if ((rows?.n ?? 0) >= limit) {
    throw new WorkbookV2Error("ROW_LIMIT_EXCEEDED", 422, `This workbook already holds its limit of ${limit.toLocaleString("en-US")} rows.`, { limit, rows: rows?.n ?? 0 });
  }

  let matched = chosen?.length ?? 0;
  if (!chosen && source.type === "list") {
    const [members] = await db.select({ n: count() }).from(listMembers).where(eq(listMembers.listId, named.id!));
    matched = members?.n ?? 0;
  } else if (!chosen) {
    matched = await fromSearch(deps.directory, () => deps.directory.count(filters!));
  }
  if (!matched) throw new WorkbookV2Error("NOTHING_TO_ADD", 422, "There are no prospects to add.");
  const background = matched > SYNC_ROW_LIMIT;
  if (background && !(await deps.queue.ready())) {
    throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, `Adding more than ${SYNC_ROW_LIMIT.toLocaleString("en-US")} prospects runs in the background, which is unavailable right now. Try again shortly.`);
  }

  const id = randomUUID();
  const collect = !chosen && source.type === "smart_list";
  const everyone = !chosen && source.type === "list";
  const plan: ProspectPlan = {
    source: { type: source.type as ProspectSourceType, ...named },
    ...(filters ? { filters } : {}),
    collect,
    chosen: chosen !== null,
    background,
    ...(everyone && matched > limit ? { truncated: { matched, considered: limit } } : {}),
    headers: ["Prospect id", "Name", "Company domain"],
    fields: {},
    requestId: actor.requestId ?? null,
  };
  try {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.insert(workbookImports).values({
        id,
        workbookId,
        sourceType: source.type,
        status: "queued",
        createdBy: actor.userId,
        plan: plan as unknown as Record<string, unknown>,
        counts: { total: chosen?.length ?? (everyone ? Math.min(matched, limit) : 0), processed: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 },
        confirmedAt: sql`now()`,
      });
      if (chosen) await insertItems(tx, id, chosen);
      else if (everyone) {
        // The members as they are now, in the order they joined the list.
        await tx.execute(sql`
          INSERT INTO workbook_import_items (import_id, seq, prospect_id)
          SELECT ${id}::uuid, row_number() OVER (ORDER BY m.added_at, m.prospect_id), m.prospect_id
          FROM (SELECT prospect_id, added_at FROM list_members WHERE list_id = ${named.id!} ORDER BY added_at, prospect_id LIMIT ${limit}) m`);
        // Counted again from what was fixed, in case the list changed since it was counted.
        await tx.execute(sql`
          UPDATE workbook_imports SET counts = jsonb_set(counts, '{total}', to_jsonb((SELECT count(*)::int FROM workbook_import_items WHERE import_id = ${id})))
          WHERE id = ${id}`);
      }
    });
  } catch (error) {
    // The error's text would quote the chosen ids.
    throw new ImportFailure("Could not start adding prospects", error);
  }
  await startImport(db, deps, { importId: id, workspaceId: actor.workspaceId }, background);
  return { background, data: await getImport(db, actor.workspaceId, workbookId, id) };
}
