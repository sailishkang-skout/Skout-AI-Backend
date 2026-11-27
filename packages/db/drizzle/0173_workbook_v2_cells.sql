-- Workbooks V2 (WB2-010) 4/8: cells, with the storage design chosen by the WB2-003 spike.
--  * PARTITION BY HASH (workbook_id), 64 partitions: a sort or filter on one workbook reads only its partition,
--    and no DDL is needed when a workbook is created.
--  * The primary key must contain the partition column, so it is (workbook_id, row_id, column_id).
--    (row_id, column_id) stays unique: row ids are unique across workbooks and the composite foreign key
--    forces a cell's workbook_id to be its row's workbook.
--  * The composite foreign keys also make it impossible to join a row and a column of different workbooks.
--  * fillfactor 80 and no secondary index keep cell updates HOT. Do not index "value" (btree entries over
--    2,704 bytes are refused), and re-measure before indexing "state".
-- drizzle-kit cannot express PARTITION BY: this table is maintained by hand.
CREATE TABLE IF NOT EXISTS "workbook_cells" (
	"workbook_id" uuid NOT NULL,
	"row_id" bigint NOT NULL,
	"column_id" uuid NOT NULL,
	"value" jsonb,
	"state" text NOT NULL,
	"confidence" real,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"found_via" text,
	"internal_provenance" jsonb,
	"error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbook_cells_pkey" PRIMARY KEY ("workbook_id", "row_id", "column_id"),
	CONSTRAINT "workbook_cells_row_fk" FOREIGN KEY ("workbook_id", "row_id") REFERENCES "workbook_rows"("workbook_id", "id") ON DELETE cascade,
	CONSTRAINT "workbook_cells_column_fk" FOREIGN KEY ("workbook_id", "column_id") REFERENCES "workbook_columns"("workbook_id", "id") ON DELETE cascade,
	CONSTRAINT "workbook_cells_state_check" CHECK ("state" IN ('queued','running','found','not_found','skipped','error','needs_input')),
	CONSTRAINT "workbook_cells_found_via_check" CHECK ("found_via" IS NULL OR "found_via" IN ('skout','cache') OR "found_via" ~ '^own_key:[a-z0-9_.-]+$')
) PARTITION BY HASH ("workbook_id");--> statement-breakpoint
-- Storage parameters cannot be set on the partitioned parent, so fillfactor goes on every partition.
DO $$
BEGIN
	FOR i IN 0..63 LOOP
		EXECUTE format(
			'CREATE TABLE IF NOT EXISTS %I PARTITION OF "workbook_cells" FOR VALUES WITH (MODULUS 64, REMAINDER %s) WITH (fillfactor = 80)',
			'workbook_cells_p' || i, i
		);
	END LOOP;
END $$;
