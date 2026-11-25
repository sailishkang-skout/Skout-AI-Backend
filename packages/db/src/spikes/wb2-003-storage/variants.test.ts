import { describe, expect, it } from "vitest";
import { assertSafeDatabaseUrl, idOf } from "./db.js";
import { INDEX_NAMES, VARIANTS, createDdl, createWorkbookPartitionDdl, dropSecondaryIndexesDdl, indexSetDdl, schemaOf, variantByKey } from "./variants.js";

const cellsDdl = (key: string) => createDdl(variantByKey(key)).find((s) => s.includes(`${schemaOf(variantByKey(key))}.workbook_cells (`))!;

describe("storage variants", () => {
  it("defines the PRD tables exactly once per variant, in their own schema", () => {
    for (const v of VARIANTS) {
      const ddl = createDdl(v).join("\n");
      expect(ddl).toContain(`CREATE SCHEMA ${schemaOf(v)}`);
      for (const table of ["workbooks", "workbook_columns", "workbook_rows", "workbook_cells", "workbook_runs", "workbook_imports", "workbook_views", "workbook_webhooks"]) {
        expect(ddl).toContain(`${schemaOf(v)}.${table} (`);
      }
      // Never touches the public schema or the legacy tables, except to reference them.
      expect(ddl).not.toMatch(/(CREATE|ALTER|DROP) TABLE public\./);
    }
  });

  it("keeps the PRD columns on workbook_cells and the (workbook_id, position) rows index", () => {
    const ddl = createDdl(variantByKey("a")).join("\n");
    for (const col of ["value jsonb", "state text", "confidence real", "credits_charged integer", "found_via text", "internal_provenance jsonb", "error_code text", "updated_at timestamptz"]) {
      expect(ddl).toContain(col);
    }
    expect(ddl).toMatch(/workbook_rows_workbook_position_idx ON wbs_a\.workbook_rows \(workbook_id, position\)/);
  });

  it("the PRD-literal primary key (row_id, column_id) is used where it is legal", () => {
    expect(cellsDdl("a")).toContain("PRIMARY KEY (row_id, column_id)");
    expect(cellsDdl("c")).toContain("PRIMARY KEY (row_id, column_id)");
    expect(cellsDdl("c")).toContain("PARTITION BY HASH (row_id)");
  });

  it("partitioning by workbook forces workbook_id into the primary key (a Postgres rule)", () => {
    for (const key of ["b", "d"]) {
      expect(cellsDdl(key)).toContain("PRIMARY KEY (workbook_id, row_id, column_id)");
      expect(cellsDdl(key)).toContain("workbook_id uuid NOT NULL");
    }
    expect(cellsDdl("b")).toContain("PARTITION BY HASH (workbook_id)");
    expect(cellsDdl("d")).toContain("PARTITION BY LIST (workbook_id)");
  });

  it("composite foreign keys exist exactly when workbook_id is on the cell", () => {
    for (const v of VARIANTS) {
      const ddl = cellsDdl(v.key);
      expect(ddl.includes("FOREIGN KEY (workbook_id, row_id)")).toBe(v.workbookIdOnCells);
      expect(ddl.includes("FOREIGN KEY (workbook_id, column_id)")).toBe(v.workbookIdOnCells);
    }
  });

  it("creates 16 hash partitions, and a list partition only per workbook", () => {
    expect(createDdl(variantByKey("b")).filter((s) => s.includes("PARTITION OF")).length).toBe(16);
    expect(createDdl(variantByKey("c")).filter((s) => s.includes("PARTITION OF")).length).toBe(16);
    expect(createDdl(variantByKey("d")).filter((s) => s.includes("PARTITION OF"))).toEqual([expect.stringContaining("DEFAULT")]);
    const [part] = createWorkbookPartitionDdl(variantByKey("d"), "11111111-2222-3333-4444-555555555555");
    expect(part).toContain("FOR VALUES IN ('11111111-2222-3333-4444-555555555555')");
    expect(createWorkbookPartitionDdl(variantByKey("a"), "x")).toEqual([]);
  });

  it("the final candidate (F) is bigint ids + hash(workbook_id) x64, with fillfactor set on each partition", () => {
    const v = variantByKey("f");
    expect(v).toMatchObject({ partition: "hash_workbook", partitions: 64, idType: "bigint", workbookIdOnCells: true, fillfactor: 80 });
    const ddl = createDdl(v);
    expect(ddl.filter((s) => s.includes("PARTITION OF"))).toHaveLength(64);
    expect(ddl.filter((s) => s.includes("PARTITION OF")).every((s) => s.includes("WITH (fillfactor=80)"))).toBe(true);
    expect(cellsDdl("f")).toContain("PRIMARY KEY (workbook_id, row_id, column_id)");
    expect(cellsDdl("f")).not.toContain("WITH (fillfactor"); // not allowed on a partitioned parent
  });

  it("bigint variants use an identity id; uuid variants use the repo's uuid default", () => {
    expect(createDdl(variantByKey("e")).join("\n")).toContain("bigint GENERATED ALWAYS AS IDENTITY");
    expect(createDdl(variantByKey("a")).join("\n")).toContain("uuid PRIMARY KEY DEFAULT gen_random_uuid()");
  });

  it("index sets are cumulative, and no set indexes the raw jsonb value", () => {
    const v = variantByKey("a");
    expect(indexSetDdl(v, "i0")).toEqual([]);
    expect(indexSetDdl(v, "i1")).toHaveLength(1);
    expect(indexSetDdl(v, "i2")).toHaveLength(2);
    for (const set of ["i1", "i2", "i3"] as const) {
      for (const stmt of indexSetDdl(v, set)) expect(stmt).not.toMatch(/\(column_id,\s*value[,)]/);
    }
    expect(dropSecondaryIndexesDdl(v)).toHaveLength(INDEX_NAMES.length);
  });
});

describe("safety guard", () => {
  it("only allows a local database with 'spike' in its name", () => {
    expect(() => assertSafeDatabaseUrl("postgresql://u:p@localhost:55432/skout_spike")).not.toThrow();
    expect(() => assertSafeDatabaseUrl("postgresql://u:p@127.0.0.1:5432/wb_spike_test")).not.toThrow();
    expect(() => assertSafeDatabaseUrl("postgresql://u:p@localhost:5434/skout")).toThrow(/Refusing/);
    expect(() => assertSafeDatabaseUrl("postgresql://u:p@prod-db.example.com:5432/skout_spike")).toThrow(/Refusing/);
  });
});

describe("deterministic ids", () => {
  it("derives a stable, uuid-shaped id", () => {
    expect(idOf("main", "row", 7)).toBe(idOf("main", "row", 7));
    expect(idOf("main", "row", 7)).not.toBe(idOf("main", "row", 8));
    expect(idOf("main", "row", 7)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
