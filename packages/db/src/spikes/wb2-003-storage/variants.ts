/**
 * WB2-003 storage spike: the candidate physical designs for the PRD §9 workbook tables.
 *
 * Everything lives in a throwaway schema per variant (`wbs_<key>`), so the spike never touches the
 * public schema or the legacy enrichment_workbooks tables. Only workbook_cells differs between variants;
 * workbooks, workbook_columns and workbook_rows are the PRD tables as written.
 */

export type PartitionKind = "none" | "hash_workbook" | "hash_row" | "list_workbook";

export interface Variant {
  key: string;
  label: string;
  partition: PartitionKind;
  /** Hash modulus (hash_*) — ignored otherwise. */
  partitions: number;
  /** Type of workbook_rows.id / workbook_cells.row_id. The repo convention is uuid. */
  idType: "uuid" | "bigint";
  /**
   * workbook_id copied onto each cell. Not in the PRD column list, but it is required to partition by
   * workbook (a partitioned table's primary key must contain the partition key) and it lets composite
   * foreign keys stop a cell linking a row of one workbook to a column of another.
   */
  workbookIdOnCells: boolean;
  /** Heap fillfactor of workbook_cells. Below 100 leaves room for HOT updates. */
  fillfactor: number;
}

export const VARIANTS: readonly Variant[] = [
  { key: "a", label: "A  unpartitioned, PRD literal", partition: "none", partitions: 1, idType: "uuid", workbookIdOnCells: false, fillfactor: 100 },
  { key: "a2", label: "A2 unpartitioned + workbook_id", partition: "none", partitions: 1, idType: "uuid", workbookIdOnCells: true, fillfactor: 100 },
  { key: "b", label: "B  hash(workbook_id) x16", partition: "hash_workbook", partitions: 16, idType: "uuid", workbookIdOnCells: true, fillfactor: 100 },
  { key: "c", label: "C  hash(row_id) x16", partition: "hash_row", partitions: 16, idType: "uuid", workbookIdOnCells: false, fillfactor: 100 },
  { key: "d", label: "D  list(workbook_id), one per workbook", partition: "list_workbook", partitions: 1, idType: "uuid", workbookIdOnCells: true, fillfactor: 100 },
  { key: "e", label: "E  unpartitioned, bigint ids", partition: "none", partitions: 1, idType: "bigint", workbookIdOnCells: false, fillfactor: 100 },
  { key: "e2", label: "E2 bigint ids + workbook_id", partition: "none", partitions: 1, idType: "bigint", workbookIdOnCells: true, fillfactor: 100 },
  { key: "f", label: "F  bigint ids + hash(workbook_id) x64 + fillfactor 80", partition: "hash_workbook", partitions: 64, idType: "bigint", workbookIdOnCells: true, fillfactor: 80 },
  { key: "a2ff", label: "A2 + fillfactor 80", partition: "none", partitions: 1, idType: "uuid", workbookIdOnCells: true, fillfactor: 80 },
  { key: "e2ff", label: "E2 bigint ids + workbook_id + fillfactor 80", partition: "none", partitions: 1, idType: "bigint", workbookIdOnCells: true, fillfactor: 80 },
];

export function variantByKey(key: string): Variant {
  const v = VARIANTS.find((x) => x.key === key);
  if (!v) throw new Error(`Unknown variant "${key}". Known: ${VARIANTS.map((x) => x.key).join(", ")}`);
  return v;
}

/** Tests set WB_SPIKE_SCHEMA_PREFIX so they never create or drop the schemas holding real benchmark data. */
export const schemaOf = (v: Variant) => `${process.env.WB_SPIKE_SCHEMA_PREFIX ?? "wbs_"}${v.key}`;

export const CELL_STATES = ["queued", "running", "found", "not_found", "skipped", "error", "needs_input"] as const;
export const COLUMN_TYPES = ["input", "enrichment", "ai", "formula", "action"] as const;

/** The table names, schema-qualified. */
export function tables(v: Variant) {
  const s = schemaOf(v);
  return {
    schema: s,
    workbooks: `${s}.workbooks`,
    columns: `${s}.workbook_columns`,
    rows: `${s}.workbook_rows`,
    cells: `${s}.workbook_cells`,
    runs: `${s}.workbook_runs`,
    imports: `${s}.workbook_imports`,
    views: `${s}.workbook_views`,
    webhooks: `${s}.workbook_webhooks`,
  };
}

/** DDL for one variant, in dependency order. Secondary indexes are added separately (see INDEX_SETS). */
export function createDdl(v: Variant): string[] {
  const t = tables(v);
  const rowIdCol = v.idType === "uuid" ? "uuid PRIMARY KEY DEFAULT gen_random_uuid()" : "bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY";
  const wbCompositeKeys = v.workbookIdOnCells;

  const out: string[] = [
    `CREATE SCHEMA ${t.schema}`,
    `CREATE TABLE ${t.workbooks} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
      name text NOT NULL,
      row_count integer NOT NULL DEFAULT 0,
      row_limit integer NOT NULL DEFAULT 100000,
      created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      archived_source_id uuid REFERENCES public.enrichment_workbooks(id) ON DELETE SET NULL
    )`,
    `CREATE INDEX ON ${t.workbooks} (workspace_id) WHERE deleted_at IS NULL`,
    `CREATE TABLE ${t.columns} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workbook_id uuid NOT NULL REFERENCES ${t.workbooks}(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL CHECK (type IN ('input','enrichment','ai','formula','action')),
      operation text,
      config jsonb NOT NULL DEFAULT '{}',
      position integer NOT NULL,
      width integer NOT NULL DEFAULT 160,
      hidden boolean NOT NULL DEFAULT false,
      frozen boolean NOT NULL DEFAULT false
      ${wbCompositeKeys ? ", UNIQUE (workbook_id, id)" : ""}
    )`,
    `CREATE INDEX ON ${t.columns} (workbook_id, position)`,
    `CREATE TABLE ${t.rows} (
      id ${rowIdCol},
      workbook_id uuid NOT NULL REFERENCES ${t.workbooks}(id) ON DELETE CASCADE,
      position integer NOT NULL,
      source jsonb NOT NULL DEFAULT '{}',
      prospect_id uuid,
      crm_ref jsonb,
      suppressed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
      ${wbCompositeKeys ? ", UNIQUE (workbook_id, id)" : ""}
    )`,
    // PRD §9: "Index on (workbook_id, position)".
    `CREATE INDEX workbook_rows_workbook_position_idx ON ${t.rows} (workbook_id, position)`,
  ];

  const rowIdType = v.idType === "uuid" ? "uuid" : "bigint";
  const cellCols = `
      ${wbCompositeKeys ? "workbook_id uuid NOT NULL," : ""}
      row_id ${rowIdType} NOT NULL,
      column_id uuid NOT NULL,
      value jsonb,
      state text NOT NULL CHECK (state IN ('queued','running','found','not_found','skipped','error','needs_input')),
      confidence real,
      credits_charged integer NOT NULL DEFAULT 0,
      found_via text,
      internal_provenance jsonb,
      error_code text,
      updated_at timestamptz NOT NULL DEFAULT now()`;

  // A partitioned table's primary key must contain every partition column, so the PRD's
  // PRIMARY KEY (row_id, column_id) is only legal when partitioning by row_id (or not at all).
  const pk = v.partition === "hash_workbook" || v.partition === "list_workbook" ? "workbook_id, row_id, column_id" : "row_id, column_id";
  const fks = wbCompositeKeys
    ? `,
      FOREIGN KEY (workbook_id, row_id) REFERENCES ${t.rows}(workbook_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workbook_id, column_id) REFERENCES ${t.columns}(workbook_id, id) ON DELETE CASCADE`
    : `,
      FOREIGN KEY (row_id) REFERENCES ${t.rows}(id) ON DELETE CASCADE,
      FOREIGN KEY (column_id) REFERENCES ${t.columns}(id) ON DELETE CASCADE`;
  const partBy =
    v.partition === "hash_workbook"
      ? " PARTITION BY HASH (workbook_id)"
      : v.partition === "hash_row"
        ? " PARTITION BY HASH (row_id)"
        : v.partition === "list_workbook"
          ? " PARTITION BY LIST (workbook_id)"
          : "";
  const withFf = v.partition === "none" && v.fillfactor < 100 ? ` WITH (fillfactor=${v.fillfactor})` : "";

  out.push(`CREATE TABLE ${t.cells} (${cellCols},
      PRIMARY KEY (${pk})${fks}
    )${partBy}${withFf}`);

  if (v.partition === "hash_workbook" || v.partition === "hash_row") {
    for (let i = 0; i < v.partitions; i++) {
      // Storage parameters cannot be set on a partitioned parent, so fillfactor goes on each partition.
      out.push(`CREATE TABLE ${t.cells}_p${i} PARTITION OF ${t.cells} FOR VALUES WITH (MODULUS ${v.partitions}, REMAINDER ${i})${v.fillfactor < 100 ? ` WITH (fillfactor=${v.fillfactor})` : ""}`);
    }
  }
  if (v.partition === "list_workbook") out.push(`CREATE TABLE ${t.cells}_default PARTITION OF ${t.cells} DEFAULT`);

  // The other PRD §9 tables: created so the full schema is exercised, but not benchmarked in this spike.
  out.push(
    `CREATE TABLE ${t.runs} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workbook_id uuid NOT NULL REFERENCES ${t.workbooks}(id) ON DELETE CASCADE,
      column_id uuid NOT NULL REFERENCES ${t.columns}(id) ON DELETE CASCADE,
      scope text NOT NULL, row_filter jsonb, status text NOT NULL,
      max_credits integer NOT NULL DEFAULT 0, credits_used integer NOT NULL DEFAULT 0, ai_actions_used integer NOT NULL DEFAULT 0,
      counts jsonb NOT NULL DEFAULT '{}', started_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
    )`,
    `CREATE TABLE ${t.imports} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workbook_id uuid NOT NULL REFERENCES ${t.workbooks}(id) ON DELETE CASCADE,
      source_type text NOT NULL, status text NOT NULL, counts jsonb NOT NULL DEFAULT '{}', error_report_file text,
      created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    )`,
    `CREATE TABLE ${t.views} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workbook_id uuid NOT NULL REFERENCES ${t.workbooks}(id) ON DELETE CASCADE,
      name text NOT NULL, filter jsonb, sort jsonb, hidden_columns uuid[] NOT NULL DEFAULT '{}'
    )`,
    `CREATE TABLE ${t.webhooks} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workbook_id uuid NOT NULL REFERENCES ${t.workbooks}(id) ON DELETE CASCADE,
      token_hash text NOT NULL, enabled boolean NOT NULL DEFAULT true, last_used_at timestamptz
    )`
  );
  return out;
}

/** List partitioning needs a partition per workbook, created before the workbook's first cell. */
export function createWorkbookPartitionDdl(v: Variant, workbookId: string): string[] {
  if (v.partition !== "list_workbook") return [];
  const t = tables(v);
  return [`CREATE TABLE ${t.cells}_wb_${workbookId.replace(/-/g, "")} PARTITION OF ${t.cells} FOR VALUES IN ('${workbookId}')`];
}

export type IndexSetKey = "i0" | "i1" | "i2" | "i3";

/**
 * Secondary-index sets, cumulative. i0 is the PRD minimum (primary keys + rows index only).
 * Index names are fixed so a set can be dropped and replaced.
 */
export function indexSetDdl(v: Variant, set: IndexSetKey): string[] {
  const c = tables(v).cells;
  const colStateRow = `CREATE INDEX workbook_cells_col_state_row_idx ON ${c} (column_id, state, row_id)`;
  // Never index the raw jsonb value: a btree entry over 2,704 bytes is refused, and AI text can be longer.
  const colValuePrefix = `CREATE INDEX workbook_cells_col_value_idx ON ${c} (column_id, (left(value #>> '{}', 64)), row_id)`;
  const covering = `CREATE INDEX workbook_cells_col_row_cover_idx ON ${c} (column_id, row_id) INCLUDE (state, value)`;
  switch (set) {
    case "i0":
      return [];
    case "i1":
      return [colStateRow];
    case "i2":
      return [colStateRow, colValuePrefix];
    case "i3":
      return [colStateRow, covering];
  }
}

export const INDEX_NAMES = ["workbook_cells_col_state_row_idx", "workbook_cells_col_value_idx", "workbook_cells_col_row_cover_idx"] as const;

export function dropSecondaryIndexesDdl(v: Variant): string[] {
  const s = schemaOf(v);
  return INDEX_NAMES.map((n) => `DROP INDEX IF EXISTS ${s}.${n}`);
}
