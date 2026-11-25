/**
 * The access patterns the Rows API (WB2-012) will need, as plain SQL for each storage variant.
 *
 * Read queries name their columns explicitly and never select internal_provenance: that column is
 * server-only (PRD §8 / WB2-045) and must not reach a browser-bound response.
 */
import { type Variant, tables } from "./variants.js";

export const WINDOW_SIZE = 200;

/** Columns a grid cell needs. No internal_provenance, on purpose. */
const CELL_COLUMNS = "c.column_id, c.value, c.state, c.confidence, c.credits_charged, c.found_via, c.error_code, c.updated_at";

/** Partition pruning needs the workbook_id predicate on the cells table where the variant has it. */
const wbOnCells = (v: Variant, alias: string) => (v.workbookIdOnCells ? ` AND ${alias}.workbook_id = $1` : "");

/**
 * Workbook predicate for statements that touch only the cells table. Where the variant has no
 * workbook_id on cells, $1 still has to be referenced or Postgres cannot type it.
 */
const wbGuard = (v: Variant, alias = "") => {
  const col = alias ? `${alias}.workbook_id` : "workbook_id";
  return v.workbookIdOnCells ? ` AND ${col} = $1` : " AND $1::uuid IS NOT NULL";
};

/**
 * Cells of the 200 page rows, joined back on to the page. `order` is how the 200 rows must come back: by position for
 * plain and filtered windows, and by the sort key for a sorted window (the page CTE carries `sort_key` for that).
 * Ordering a sorted page by position alone returns the right rows in the wrong order.
 */
function cellsOfPage(v: Variant, order = "p.position"): string {
  const t = tables(v);
  return `SELECT p.id AS row_id, p.position, p.source, p.suppressed, ${CELL_COLUMNS}
    FROM page p LEFT JOIN ${t.cells} c ON c.row_id = p.id${wbOnCells(v, "c")}
    ORDER BY ${order}, c.column_id`;
}

/** Window by position, no sort or filter. $1 workbook id, $2 first position. */
export function windowSql(v: Variant): string {
  const t = tables(v);
  return `WITH page AS (
    SELECT id, position, source, suppressed FROM ${t.rows}
    WHERE workbook_id = $1 AND position >= $2 ORDER BY position LIMIT ${WINDOW_SIZE}
  ) ${cellsOfPage(v)}`;
}

/** Window sorted by one cell column, across all rows. $1 workbook id, $2 column id, $3 offset. */
export function sortedWindowSql(v: Variant, dir: "ASC" | "DESC" = "ASC", key: "value" | "prefix" = "value"): string {
  const t = tables(v);
  const expr = key === "prefix" ? "left(s.value #>> '{}', 64)" : "s.value";
  return `WITH page AS (
    SELECT r.id, r.position, r.source, r.suppressed, ${expr} AS sort_key FROM ${t.rows} r
    LEFT JOIN ${t.cells} s ON s.row_id = r.id AND s.column_id = $2${wbOnCells(v, "s")}
    WHERE r.workbook_id = $1
    ORDER BY ${expr} ${dir} NULLS LAST, r.position
    LIMIT ${WINDOW_SIZE} OFFSET $3
  ) ${cellsOfPage(v, `p.sort_key ${dir} NULLS LAST, p.position`)}`;
}

export type FilterKind = "state_error" | "value_equals" | "text_contains" | "numeric_gt" | "is_empty";

export interface FilterSpec {
  kind: FilterKind;
  /** Column index in dataset.COLUMN_SPECS the filter applies to. */
  column: number;
  /** WHERE fragment over alias s (the filtered column's cell). */
  predicate: string;
  /** LEFT JOIN when a missing cell must count (is_empty), INNER otherwise. */
  left: boolean;
  description: string;
}

export const FILTERS: Record<FilterKind, FilterSpec> = {
  state_error: { kind: "state_error", column: 7, predicate: "s.state = 'error'", left: false, description: "Work email: state is error (~6% of rows)" },
  value_equals: { kind: "value_equals", column: 8, predicate: `s.value = '"valid"'::jsonb`, left: false, description: "Email status = valid (~40% of rows)" },
  text_contains: { kind: "text_contains", column: 3, predicate: "(s.value #>> '{}') ILIKE '%.io'", left: false, description: "Domain ends with .io (~17% of rows)" },
  numeric_gt: {
    kind: "numeric_gt",
    column: 15,
    predicate: "(CASE WHEN jsonb_typeof(s.value) = 'number' THEN (s.value)::numeric END) > 80",
    left: false,
    description: "Lead score > 80 (~19% of rows)",
  },
  is_empty: { kind: "is_empty", column: 9, predicate: "(s.value IS NULL)", left: true, description: "Phone is empty (~42% of rows)" },
};

/** Window of rows matching a filter. $1 workbook id, $2 column id, $3 offset. */
export function filteredWindowSql(v: Variant, f: FilterSpec): string {
  const t = tables(v);
  return `WITH page AS (
    SELECT r.id, r.position, r.source, r.suppressed FROM ${t.rows} r
    ${f.left ? "LEFT" : "INNER"} JOIN ${t.cells} s ON s.row_id = r.id AND s.column_id = $2${wbOnCells(v, "s")}
    WHERE r.workbook_id = $1 AND ${f.predicate}
    ORDER BY r.position
    LIMIT ${WINDOW_SIZE} OFFSET $3
  ) ${cellsOfPage(v)}`;
}

/** Number of rows matching a filter (the "filtered count" the grid always shows). $1 workbook id, $2 column id. */
export function filteredCountSql(v: Variant, f: FilterSpec): string {
  const t = tables(v);
  return `SELECT count(*)::int AS n FROM ${t.rows} r
    ${f.left ? "LEFT" : "INNER"} JOIN ${t.cells} s ON s.row_id = r.id AND s.column_id = $2${wbOnCells(v, "s")}
    WHERE r.workbook_id = $1 AND ${f.predicate}`;
}

/** Filter and sort together: rows whose work email was found, ordered by company. $1 wb, $2 filter column id, $3 sort column id, $4 offset. */
export function filteredSortedWindowSql(v: Variant): string {
  const t = tables(v);
  return `WITH page AS (
    SELECT r.id, r.position, r.source, r.suppressed, s.value AS sort_key FROM ${t.rows} r
    JOIN ${t.cells} f ON f.row_id = r.id AND f.column_id = $2${wbOnCells(v, "f")} AND f.state = 'found'
    LEFT JOIN ${t.cells} s ON s.row_id = r.id AND s.column_id = $3${wbOnCells(v, "s")}
    WHERE r.workbook_id = $1
    ORDER BY s.value NULLS LAST, r.position
    LIMIT ${WINDOW_SIZE} OFFSET $4
  ) ${cellsOfPage(v, "p.sort_key NULLS LAST, p.position")}`;
}

/** Row ids and positions of a position range (the runner's chunk). $1 workbook id, $2 first position, $3 count. */
export function chunkRowIdsSql(v: Variant): string {
  return `SELECT id, position FROM ${tables(v).rows} WHERE workbook_id = $1 AND position >= $2 ORDER BY position LIMIT $3`;
}

/**
 * Runner step 1: claim cells for one column (compare-and-set into 'running'). Only cells not already
 * running are claimed, so two runs cannot both own a cell. $1 wb, $2 column id, $3 row ids (array).
 */
export function claimSql(v: Variant): string {
  const t = tables(v);
  const idType = v.idType === "uuid" ? "uuid" : "bigint";
  return `UPDATE ${t.cells} SET state = 'running', updated_at = now()
    WHERE column_id = $2 AND row_id = ANY($3::${idType}[])${wbGuard(v)} AND state <> 'running'
    RETURNING row_id`;
}

/** Runner step 2: write the results of a chunk. $1 wb, $2 column id, $3 JSON array of results. */
export function completeSql(v: Variant): string {
  const t = tables(v);
  const idType = v.idType === "uuid" ? "uuid" : "bigint";
  return `UPDATE ${t.cells} c SET value = v.value, state = v.state, confidence = v.confidence, credits_charged = v.credits_charged,
      found_via = v.found_via, internal_provenance = v.internal_provenance, error_code = v.error_code, updated_at = now()
    FROM jsonb_to_recordset($3::jsonb) AS v(row_id ${idType}, value jsonb, state text, confidence real, credits_charged int, found_via text, internal_provenance jsonb, error_code text)
    WHERE c.column_id = $2 AND c.row_id = v.row_id${wbGuard(v, "c")} AND c.state = 'running'`;
}

/** A user editing one input cell. $1 wb, $2 row id, $3 column id, $4 new value. */
export function editCellSql(v: Variant): string {
  const t = tables(v);
  return `UPDATE ${t.cells} SET value = $4::jsonb, updated_at = now() WHERE row_id = $2 AND column_id = $3${wbGuard(v)}`;
}
