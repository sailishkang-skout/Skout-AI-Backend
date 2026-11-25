-- WB2-003 recommended storage design for WB2-010 (REFERENCE, not a migration).
-- Evidence: WB2-003-storage-decision.md. Variant "F" in packages/db/src/spikes/wb2-003-storage/variants.ts.
--
-- Differences from PRD §9, each forced or justified by a measurement:
--   1. workbook_cells carries workbook_id, and its primary key is (workbook_id, row_id, column_id).
--      Postgres requires a partitioned table's primary key to contain the partition column, so the PRD's
--      PRIMARY KEY (row_id, column_id) cannot be created on a table partitioned by workbook_id.
--   2. Composite foreign keys (workbook_id, row_id) and (workbook_id, column_id) make it impossible for a cell to join
--      a row of one workbook to a column of another. With only (row_id, column_id) keys that link is accepted.
--   3. workbook_rows.id is a bigint identity, not a uuid: ~15% fewer bytes per cell, ~12% faster concurrent writes, and a
--      4x faster worst-case filter+sort at 12M cells (probably because sequential ids keep a workbook's cells together on
--      disk; that explanation was not isolated). Sequential ids are guessable, so the API must scope every read by workbook_id.
--   4. Cell partitions use fillfactor 80 and the table has NO secondary index, so updates to value/state/confidence
--      stay HOT (94% measured). Never index the raw jsonb `value`: btree entries over 2,704 bytes are refused.
--
-- Drizzle note: drizzle-kit cannot generate PARTITION BY. Ship this as a hand-written, journaled SQL migration
-- (packages/db/drizzle + meta/_journal.json, checked by scripts/check-migrations.mjs) and declare the tables in
-- packages/db/src/schema/ as ordinary pgTable()s so the types and queries work. Each migration runs in a transaction,
-- so no CREATE INDEX CONCURRENTLY here. Add a `-- migration-safety:` comment if the gate asks for one.

CREATE TABLE workbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  row_limit integer NOT NULL DEFAULT 100000,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  archived_source_id uuid REFERENCES enrichment_workbooks(id) ON DELETE SET NULL  -- drop this FK with the legacy tables (MIG-4)
);
CREATE INDEX workbooks_workspace_idx ON workbooks (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE workbook_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id uuid NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('input','enrichment','ai','formula','action')),
  operation text,
  config jsonb NOT NULL DEFAULT '{}',
  position integer NOT NULL,
  width integer NOT NULL DEFAULT 160,
  hidden boolean NOT NULL DEFAULT false,
  frozen boolean NOT NULL DEFAULT false,
  UNIQUE (workbook_id, id)
);
CREATE INDEX workbook_columns_workbook_position_idx ON workbook_columns (workbook_id, position);

CREATE TABLE workbook_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workbook_id uuid NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  position integer NOT NULL,
  source jsonb NOT NULL DEFAULT '{}',
  prospect_id uuid,
  crm_ref jsonb,
  suppressed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workbook_id, id)
);
CREATE INDEX workbook_rows_workbook_position_idx ON workbook_rows (workbook_id, position);  -- PRD §9, row-window reads

CREATE TABLE workbook_cells (
  workbook_id uuid NOT NULL,
  row_id bigint NOT NULL,
  column_id uuid NOT NULL,
  value jsonb,
  state text NOT NULL CHECK (state IN ('queued','running','found','not_found','skipped','error','needs_input')),
  confidence real,
  credits_charged integer NOT NULL DEFAULT 0,
  found_via text,                 -- skout | own_key:<provider> | cache  (browser-visible)
  internal_provenance jsonb,      -- SERVER ONLY. Never select it in a browser-bound query.
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workbook_id, row_id, column_id),
  FOREIGN KEY (workbook_id, row_id) REFERENCES workbook_rows (workbook_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workbook_id, column_id) REFERENCES workbook_columns (workbook_id, id) ON DELETE CASCADE
) PARTITION BY HASH (workbook_id);

-- 64 hash partitions: bounded partition count, no per-workbook DDL, and a sort/filter on one workbook reads only
-- its own partition. Storage parameters cannot be set on the partitioned parent, so fillfactor goes on each child.
DO $$
BEGIN
  FOR i IN 0..63 LOOP
    EXECUTE format('CREATE TABLE workbook_cells_p%s PARTITION OF workbook_cells FOR VALUES WITH (MODULUS 64, REMAINDER %s) WITH (fillfactor = 80)', i, i);
  END LOOP;
END $$;

-- Optional, add only if state filters / run scopes need it (measured cost: ~-14% write throughput, HOT updates 94% -> 0%,
-- WAL +65%; benefit: state filter ~3x faster at 2M cells, 69 -> 22 ms). Not part of the baseline measured end to end.
-- CREATE INDEX workbook_cells_col_state_row_idx ON workbook_cells (column_id, state, row_id);

-- workbook_runs, workbook_imports, workbook_views, workbook_webhooks: as PRD §9, each with workbook_id -> workbooks(id)
-- ON DELETE CASCADE. They were created in the spike schema (variants.ts) but not benchmarked.
