import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@skout/db";
import type { InputDataType } from "./workbook-cell-values.js";

/**
 * Server-side filter, search and sort over every row of a workbook (PRD GRID-2).
 *
 * The SQL is assembled only from the fixed fragments below. Everything a client sends (column ids, values, search
 * text) is a bound parameter; an operator or direction selects a fragment and is never itself written into the query.
 * Aliases are generated here from array indexes.
 *
 * "Empty" means the same everywhere: no cell record, SQL NULL, JSON null or an empty string. Queued, running and
 * failed enrichment cells have no value, so they are empty too. Empty values sort last in both directions.
 */
export const TEXT_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "starts_with"] as const;
export const COMPARISON_OPERATORS = ["gt", "gte", "lt", "lte"] as const;

export type Scalar = string | number | boolean;

export type RowFilter =
  | { type: "value"; columnId: string; op: "equals" | "not_equals"; value: Scalar }
  | { type: "value"; columnId: string; op: "contains" | "not_contains" | "starts_with"; value: string }
  | { type: "value"; columnId: string; op: "in"; value: Scalar[] }
  | { type: "value"; columnId: string; op: (typeof COMPARISON_OPERATORS)[number]; value: number | string }
  | { type: "value"; columnId: string; op: "is_empty" | "has_value" }
  /** The state of one column's cell or, without a column, of any cell in the row. */
  | { type: "state"; columnId?: string; states: string[] }
  | { type: "source"; sources: string[] };

export type RowSort = { columnId: string; direction: "asc" | "desc" } | { field: "position" | "createdAt" | "source"; direction: "asc" | "desc" };

export interface RowQuery {
  offset: number;
  limit: number;
  sort: RowSort[];
  filters: RowFilter[];
  search?: string;
  /** Cells to return; all when omitted. Does not affect filtering, search or sorting. */
  columnIds?: string[];
}

const list = (values: readonly unknown[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  );

/** `%`, `_` and `\` typed by the user match themselves. */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

const emptyValue = (value: SQL) => sql`(${value} IS NULL OR ${value} = 'null'::jsonb OR ${value} = '""'::jsonb)`;
const asText = (value: SQL) => sql`(${value} #>> '{}')`;
const asNumber = (value: SQL) => sql`(CASE WHEN jsonb_typeof(${value}) = 'number' THEN (${value})::numeric END)`;
const DIRECTION = { asc: sql.raw("ASC"), desc: sql.raw("DESC") } as const;
const COMPARISON = { gt: sql.raw(">"), gte: sql.raw(">="), lt: sql.raw("<"), lte: sql.raw("<=") } as const;

/** Text compares without regard to case; a number matches number cells, true/false matches checkbox cells. */
function equalsValue(value: SQL, wanted: Scalar): SQL {
  if (typeof wanted === "number") return sql`${asNumber(value)} = ${String(wanted)}::numeric`;
  if (typeof wanted === "boolean") return sql`${value} = ${sql.raw(wanted ? "'true'::jsonb" : "'false'::jsonb")}`;
  return sql`lower(${asText(value)}) = lower(${wanted})`;
}

function valuePredicate(value: SQL, filter: Extract<RowFilter, { type: "value" }>): SQL {
  switch (filter.op) {
    case "is_empty":
      return emptyValue(value);
    case "has_value":
      return sql`NOT ${emptyValue(value)}`;
    case "equals":
      return equalsValue(value, filter.value);
    // "Is not" and "does not contain" include empty cells, as a spreadsheet filter does.
    case "not_equals":
      return sql`NOT coalesce(${equalsValue(value, filter.value)}, false)`;
    case "contains":
      return sql`${asText(value)} ILIKE ${`%${escapeLike(filter.value)}%`}`;
    case "not_contains":
      return sql`NOT coalesce(${asText(value)} ILIKE ${`%${escapeLike(filter.value)}%`}, false)`;
    case "starts_with":
      return sql`${asText(value)} ILIKE ${`${escapeLike(filter.value)}%`}`;
    case "in":
      return sql`(${sql.join(
        filter.value.map((v) => equalsValue(value, v)),
        sql` OR `
      )})`;
    default: {
      const operator = COMPARISON[filter.op];
      if (typeof filter.value === "number") return sql`${asNumber(value)} ${operator} ${String(filter.value)}::numeric`;
      // An ISO date (validated by the route) compares correctly as text against ISO date cells.
      return sql`(CASE WHEN jsonb_typeof(${value}) = 'string' AND ${asText(value)} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN ${asText(value)} END) ${operator} ${filter.value}`;
    }
  }
}

/** Joins one column's cell to the row as `alias`; a row without that cell still comes through, with NULLs. */
const cellJoin = (alias: string, workbookId: string, columnId: string) => {
  const a = sql.raw(alias);
  return sql`LEFT JOIN workbook_cells ${a} ON ${a}.workbook_id = ${workbookId}::uuid AND ${a}.row_id = r.id AND ${a}.column_id = ${columnId}::uuid`;
};

function filterParts(workbookId: string, query: RowQuery) {
  const joins: SQL[] = [];
  const where: SQL[] = [sql`r.workbook_id = ${workbookId}::uuid`];
  query.filters.forEach((filter, i) => {
    if (filter.type === "source") {
      where.push(sql`r.source ->> 'type' IN (${list(filter.sources)})`);
    } else if (filter.type === "state" && !filter.columnId) {
      where.push(sql`r.id IN (SELECT x.row_id FROM workbook_cells x WHERE x.workbook_id = ${workbookId}::uuid AND x.state IN (${list(filter.states)}))`);
    } else {
      const alias = `f${i}`;
      joins.push(cellJoin(alias, workbookId, filter.columnId!));
      where.push(filter.type === "state" ? sql`${sql.raw(alias)}.state IN (${list(filter.states)})` : valuePredicate(sql.raw(`${alias}.value`), filter));
    }
  });
  if (query.search) {
    // Every text, number and checkbox value of every column; structured (object or list) values are not searched.
    where.push(sql`r.id IN (
      SELECT x.row_id FROM workbook_cells x
      WHERE x.workbook_id = ${workbookId}::uuid AND jsonb_typeof(x.value) IN ('string', 'number', 'boolean') AND (x.value #>> '{}') ILIKE ${`%${escapeLike(query.search)}%`})`);
  }
  return { joins, where };
}

function sortParts(workbookId: string, query: RowQuery, dataTypes: ReadonlyMap<string, InputDataType | undefined>) {
  const joins: SQL[] = [];
  const order: SQL[] = [];
  query.sort.forEach((sort, i) => {
    const direction = DIRECTION[sort.direction];
    if ("field" in sort) {
      const field = sort.field === "position" ? sql`r.position` : sort.field === "createdAt" ? sql`r.created_at` : sql`r.source ->> 'type'`;
      order.push(sql`${field} ${direction} NULLS LAST`);
      return;
    }
    const alias = `s${i}`;
    const stored = sql.raw(`${alias}.value`);
    // Every kind of empty becomes NULL, so empty cells tie with each other and sort last in both directions.
    const value = sql`(CASE WHEN NOT ${emptyValue(stored)} THEN ${stored} END)`;
    joins.push(cellJoin(alias, workbookId, sort.columnId));
    // In a number column, numbers come first; flagged text that did not parse follows them.
    if (dataTypes.get(sort.columnId.toLowerCase()) === "number") order.push(sql`(jsonb_typeof(${value}) = 'number') DESC NULLS LAST`);
    order.push(sql`${value} ${direction} NULLS LAST`);
  });
  // Ties (and an unsorted view) follow the rows' own order, so pages never overlap or skip.
  order.push(sql`r.position ASC`, sql`r.id ASC`);
  return { joins, order };
}

const isFiltered = (query: RowQuery) => query.filters.length > 0 || query.search !== undefined;

/**
 * The statement for one page of row ids. With filters or a search, each id also carries the number of matching rows,
 * so one pass over the workbook answers both (a second pass would double the cost of a search).
 */
export function pageStatement(workbookId: string, query: RowQuery, dataTypes: ReadonlyMap<string, InputDataType | undefined>): SQL {
  const filter = filterParts(workbookId, query);
  const sort = sortParts(workbookId, query, dataTypes);
  const matched = isFiltered(query) ? sql`, count(*) OVER ()::int AS matched` : sql``;
  return sql`SELECT r.id${matched} FROM workbook_rows r ${sql.join([...filter.joins, ...sort.joins], sql` `)}
    WHERE ${sql.join(filter.where, sql` AND `)}
    ORDER BY ${sql.join(sort.order, sql`, `)}
    LIMIT ${query.limit} OFFSET ${query.offset}`;
}

/** Counts the matching rows on its own, for a page past the last match, which has no row to carry the number. */
export function countStatement(workbookId: string, query: RowQuery): SQL {
  const filter = filterParts(workbookId, query);
  return sql`SELECT count(*)::int AS n FROM workbook_rows r ${sql.join(filter.joins, sql` `)} WHERE ${sql.join(filter.where, sql` AND `)}`;
}

export async function queryRowIds(db: Db, workbookId: string, query: RowQuery, dataTypes: ReadonlyMap<string, InputDataType | undefined>, total: number) {
  const filtered = isFiltered(query);
  if (!filtered && query.offset >= total) return { ids: [] as number[], matched: total };
  // Sorting and filtering a whole workbook joins and sorts about 100,000 rows; give it room not to spill to disk.
  if (filtered || query.sort.length) await db.execute(sql`SET LOCAL work_mem = '32MB'`);
  const page = (await db.execute(pageStatement(workbookId, query, dataTypes))) as unknown as Array<{ id: string | number; matched?: number }>;
  const ids = page.map((r) => Number(r.id));
  if (!filtered) return { ids, matched: total };
  if (page.length) return { ids, matched: Number(page[0]!.matched) };
  if (query.offset === 0) return { ids, matched: 0 };
  const [counted] = (await db.execute(countStatement(workbookId, query))) as unknown as Array<{ n: number }>;
  return { ids, matched: Number(counted!.n) };
}
