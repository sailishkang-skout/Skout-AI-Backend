import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { createDb } from "../index.js";
import {
  publicWorkbookCellColumns,
  workbookCells,
  workbookColumns,
  workbookImportIssues,
  workbookImports,
  workbookRows,
  workbookRuns,
  workbooks,
  workbookViews,
  workbookWebhooks,
} from "./workbooks.js";

/**
 * WB2-010: the migrated database against the Drizzle definitions, plus partitioning, keys, isolation,
 * cascades and the legacy tables. Runs only when COPS_TEST_DATABASE_URL is set (real, migrated Postgres),
 * which CI does.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const TABLES: PgTable[] = [workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, workbookImports, workbookViews, workbookWebhooks, workbookImportIssues];
const NAMES = ["workbooks", "workbook_columns", "workbook_rows", "workbook_cells", "workbook_runs", "workbook_imports", "workbook_views", "workbook_webhooks", "workbook_import_issues"];
const LEGACY = ["enrichment_workbooks", "enrichment_workbook_runs", "workbook_column_definitions", "workbook_column_values"];

maybe("Workbooks V2 schema (Postgres)", () => {
  const { db, sql } = createDb(url ?? "postgresql://unused@localhost:1/unused");
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaces: string[] = [];
  const users: string[] = [];

  async function workspace(label: string): Promise<string> {
    const [row] = await sql`insert into workspaces (name, slug) values (${label}, ${`wb2-${label}-${stamp}`}) returning id`;
    workspaces.push(row!.id as string);
    return row!.id as string;
  }
  async function user(label: string): Promise<string> {
    const [row] = await sql`insert into users (email) values (${`wb2-${label}-${stamp}@example.test`}) returning id`;
    users.push(row!.id as string);
    return row!.id as string;
  }
  /** A workbook with `columns` columns, `rows` rows and one cell per (row, column). */
  async function seed(workspaceId: string, createdBy: string | null = null, rows = 3, columns = 2) {
    const [wb] = await db.insert(workbooks).values({ workspaceId, name: `wb ${stamp}`, createdBy }).returning();
    const cols = await db
      .insert(workbookColumns)
      .values(Array.from({ length: columns }, (_, i) => ({ workbookId: wb!.id, name: `c${i}`, type: "input" as const, position: i })))
      .returning();
    const rws = await db.insert(workbookRows).values(Array.from({ length: rows }, (_, i) => ({ workbookId: wb!.id, position: i }))).returning();
    await db.insert(workbookCells).values(rws.flatMap((r) => cols.map((c) => ({ workbookId: wb!.id, rowId: r.id, columnId: c.id, state: "found" as const, value: "v" }))));
    return { wb: wb!, cols, rows: rws };
  }
  /** SQLSTATE of a statement that must fail, or "no error". */
  async function failsWith(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
      return "no error";
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string } };
      return err.code ?? err.cause?.code ?? String(e);
    }
  }
  const countFor = async (table: string, workbookId: string) => Number((await sql.unsafe(`select count(*)::int as n from ${table} where workbook_id = $1`, [workbookId]))[0]!.n);

  beforeAll(async () => {
    await sql`select 1`;
  });
  afterAll(async () => {
    if (workspaces.length) await sql`delete from workspaces where id = any(${workspaces})`;
    if (users.length) await sql`delete from users where id = any(${users})`;
    await sql.end();
  });

  describe("the migrated tables match the Drizzle definitions", () => {
    it("creates every table", async () => {
      const found = await sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = any(${NAMES})`;
      expect(found.map((r) => r.table_name).sort()).toEqual([...NAMES].sort());
    });

    for (const [i, table] of TABLES.entries()) {
      const name = NAMES[i]!;
      describe(name, () => {
        const config = getTableConfig(table);

        it("columns: same names, types, nullability and defaults", async () => {
          expect(config.name).toBe(name);
          const actual = await sql`
            select column_name, data_type, is_nullable, (column_default is not null or is_identity = 'YES') as has_default, is_identity
            from information_schema.columns where table_schema = 'public' and table_name = ${name}`;
          const fromDb = actual.map((c) => `${c.column_name} ${c.data_type} ${c.is_nullable === "NO" ? "not null" : "null"} ${c.has_default ? "default" : "-"}`).sort();
          const fromDrizzle = config.columns.map((c) => `${c.name} ${c.getSQLType()} ${c.notNull ? "not null" : "null"} ${c.hasDefault ? "default" : "-"}`).sort();
          expect(fromDb).toEqual(fromDrizzle);
        });

        it("primary key columns, in order", async () => {
          const actual = await sql`
            select a.attname from pg_index i
            join lateral unnest(i.indkey) with ordinality k(attnum, ord) on true
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where i.indrelid = ${name}::regclass and i.indisprimary order by k.ord`;
          const declared = config.primaryKeys.length ? config.primaryKeys[0]!.columns.map((c) => c.name) : config.columns.filter((c) => c.primary).map((c) => c.name);
          expect(actual.map((r) => r.attname)).toEqual(declared);
        });

        it("foreign keys: same columns, targets and delete rules", async () => {
          const actual = await sql`
            select
              (select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
              c.confrelid::regclass::text as target,
              (select string_agg(a.attname, ',' order by k.ord) from unnest(c.confkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as target_cols,
              case c.confdeltype when 'c' then 'cascade' when 'n' then 'set null' else c.confdeltype::text end as on_delete
            from pg_constraint c where c.conrelid = ${name}::regclass and c.contype = 'f' and c.conparentid = 0`;
          const fromDb = actual.map((f) => `(${f.cols}) -> ${f.target}(${f.target_cols}) ${f.on_delete}`).sort();
          const fromDrizzle = config.foreignKeys
            .map((fk) => {
              const ref = fk.reference();
              return `(${ref.columns.map((c) => c.name).join(",")}) -> ${getTableConfig(ref.foreignTable).name}(${ref.foreignColumns.map((c) => c.name).join(",")}) ${fk.onDelete}`;
            })
            .sort();
          expect(fromDb).toEqual(fromDrizzle);
        });

        it("indexes, unique constraints and checks: same names and columns", async () => {
          const idx = await sql`
            select c.relname as name, i.indpred is not null as partial,
              (select string_agg(a.attname, ',' order by k.ord) from unnest(i.indkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n) as cols
            from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = ${name}::regclass and not i.indisprimary`;
          const fromDb = idx.map((r) => `${r.name}(${r.cols})${r.partial ? " partial" : ""}`).sort();
          const fromDrizzle = [
            ...config.indexes.map((x) => `${x.config.name}(${x.config.columns.map((c) => (c as { name: string }).name).join(",")})${x.config.where ? " partial" : ""}`),
            ...config.uniqueConstraints.map((u) => `${u.name}(${u.columns.map((c) => c.name).join(",")})`),
          ].sort();
          expect(fromDb).toEqual(fromDrizzle);
          const checks = await sql`select conname from pg_constraint where conrelid = ${name}::regclass and contype = 'c'`;
          expect(checks.map((r) => r.conname).sort()).toEqual(config.checks.map((c) => c.name).sort());
        });
      });
    }
  });

  describe("partitioning (WB2-003 design)", () => {
    it("workbook_cells is hash partitioned on workbook_id", async () => {
      const [p] = await sql`select pg_get_partkeydef('workbook_cells'::regclass) as key`;
      expect(p!.key).toBe("HASH (workbook_id)");
    });

    it("has 64 partitions, remainders 0..63, each with fillfactor 80", async () => {
      const parts = await sql`
        select c.relname, pg_get_expr(c.relpartbound, c.oid) as bound, c.reloptions
        from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'workbook_cells'::regclass`;
      expect(parts).toHaveLength(64);
      const remainders = parts.map((p) => Number(/modulus 64, remainder (\d+)/.exec(p.bound as string)?.[1])).sort((a, b) => a - b);
      expect(remainders).toEqual(Array.from({ length: 64 }, (_, i) => i));
      for (const p of parts) expect(p.reloptions).toContain("fillfactor=80");
    });

    it("carries no secondary index: only the primary key", async () => {
      const idx = await sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'workbook_cells'`;
      expect(idx.map((r) => r.indexname)).toEqual(["workbook_cells_pkey"]);
    });

    it("keeps each workbook's cells in one partition and spreads workbooks across partitions", async () => {
      const ws = await workspace("route");
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push((await seed(ws)).wb.id);
      const placed = await sql`select workbook_id, count(distinct tableoid)::int as parts, min(tableoid::regclass::text) as part, count(*)::int as cells
        from workbook_cells where workbook_id = any(${ids}) group by workbook_id`;
      expect(placed).toHaveLength(12);
      for (const p of placed) expect(p).toMatchObject({ parts: 1, cells: 6 });
      expect(new Set(placed.map((p) => p.part)).size).toBeGreaterThan(1);
    });

    it("prunes to a single partition when a query filters by workbook", async () => {
      const { wb } = await seed(await workspace("prune"));
      const [plan] = await sql.unsafe(`explain (format json) select * from workbook_cells where workbook_id = '${wb.id}'`);
      const text = JSON.stringify(plan!["QUERY PLAN"]);
      expect(new Set(text.match(/workbook_cells_p\d+(?=")/g))).toHaveProperty("size", 1);
    });
  });

  describe("keys and isolation", () => {
    let a: Awaited<ReturnType<typeof seed>>;
    let b: Awaited<ReturnType<typeof seed>>;
    beforeAll(async () => {
      a = await seed(await workspace("iso-a"));
      b = await seed(await workspace("iso-b"));
    });
    const cell = (workbookId: string, rowId: number, columnId: string, extra: Record<string, unknown> = {}) => () =>
      db.insert(workbookCells).values({ workbookId, rowId, columnId, state: "found", ...extra });

    it("(row_id, column_id) cannot be stored twice, under the same workbook id or another one", async () => {
      const row = a.rows[0]!.id;
      const col = a.cols[0]!.id;
      expect(await failsWith(cell(a.wb.id, row, col))).toBe("23505");
      expect(await failsWith(cell(b.wb.id, row, col))).toBe("23503");
      const [n] = await sql`select count(*)::int as n from workbook_cells where row_id = ${row} and column_id = ${col}`;
      expect(n!.n).toBe(1);
    });

    it("a cell cannot join a row of one workbook to a column of another", async () => {
      const [extraRow] = await db.insert(workbookRows).values({ workbookId: a.wb.id, position: 99 }).returning();
      expect(await failsWith(cell(a.wb.id, extraRow!.id, b.cols[0]!.id))).toBe("23503");
      expect(await failsWith(cell(b.wb.id, extraRow!.id, b.cols[0]!.id))).toBe("23503");
    });

    it("a cell cannot be moved to another workbook by updating workbook_id", async () => {
      expect(await failsWith(() => sql`update workbook_cells set workbook_id = ${b.wb.id} where workbook_id = ${a.wb.id}`)).toBe("23503");
    });

    it("a run must be on a column of its own workbook", async () => {
      expect(await failsWith(() => db.insert(workbookRuns).values({ workbookId: a.wb.id, columnId: b.cols[0]!.id, scope: "all" }))).toBe("23503");
    });

    it("rejects values outside the PRD's lists", async () => {
      const [r] = await db.insert(workbookRows).values({ workbookId: a.wb.id, position: 100 }).returning();
      const col = a.cols[0]!.id;
      expect(await failsWith(cell(a.wb.id, r!.id, col, { state: "pending" }))).toBe("23514");
      expect(await failsWith(() => db.insert(workbookColumns).values({ workbookId: a.wb.id, name: "x", type: "lookup" as never, position: 9 }))).toBe("23514");
      expect(await failsWith(() => db.insert(workbookRuns).values({ workbookId: a.wb.id, columnId: col, scope: "some" as never }))).toBe("23514");
    });

    it("found_via accepts skout, cache and own_key:<provider>, and refuses a bare provider name", async () => {
      const [r] = await db.insert(workbookRows).values({ workbookId: a.wb.id, position: 101 }).returning();
      const col = a.cols[0]!.id;
      for (const bad of ["apollo", "hunter", "own_key:", "managed:apollo", "Skout"]) {
        expect(await failsWith(cell(a.wb.id, r!.id, col, { foundVia: bad })), bad).toBe("23514");
      }
      for (const good of ["skout", "cache", "own_key:hunter", null]) {
        await db.insert(workbookCells).values({ workbookId: a.wb.id, rowId: r!.id, columnId: col, state: "found", foundVia: good as never });
        await db.delete(workbookCells).where(and(eq(workbookCells.workbookId, a.wb.id), eq(workbookCells.rowId, r!.id)));
      }
    });

    it("a webhook token hash names exactly one webhook", async () => {
      const tokenHash = `hash-${stamp}`;
      await db.insert(workbookWebhooks).values({ workbookId: a.wb.id, tokenHash });
      expect(await failsWith(() => db.insert(workbookWebhooks).values({ workbookId: b.wb.id, tokenHash }))).toBe("23505");
    });

    it("a workbook must belong to an existing workspace", async () => {
      expect(await failsWith(() => db.insert(workbooks).values({ workspaceId: "00000000-0000-4000-8000-00000000dead", name: "orphan" }))).toBe("23503");
    });

    it("row ids come from the database and are unique across workbooks", async () => {
      expect(await failsWith(() => sql`insert into workbook_rows (id, workbook_id, position) values (1, ${a.wb.id}, 0)`)).toBe("428C9");
      const ids = [...a.rows, ...b.rows].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => Number.isSafeInteger(id))).toBe(true);
    });
  });

  describe("defaults, Drizzle reads and writes", () => {
    it("applies the documented defaults", async () => {
      const ws = await workspace("defaults");
      const { wb, cols, rows } = await seed(ws, null, 1, 1);
      expect(wb).toMatchObject({ rowCount: 0, rowLimit: 100_000, deletedAt: null, archivedSourceId: null });
      expect(cols[0]).toMatchObject({ config: {}, width: 160, hidden: false, frozen: false, operation: null });
      expect(rows[0]).toMatchObject({ source: {}, suppressed: false, prospectId: null, crmRef: null });
      const [run] = await db.insert(workbookRuns).values({ workbookId: wb.id, columnId: cols[0]!.id, scope: "first10" }).returning();
      expect(run).toMatchObject({ status: "queued", maxCredits: 0, creditsUsed: 0, aiActionsUsed: 0, counts: {}, rowFilter: null });
      const [imp] = await db.insert(workbookImports).values({ workbookId: wb.id, sourceType: "csv" }).returning();
      expect(imp).toMatchObject({ status: "pending", counts: {}, errorReportFile: null });
      const [view] = await db.insert(workbookViews).values({ workbookId: wb.id, name: "All" }).returning();
      expect(view).toMatchObject({ filters: [], sorts: [], hiddenColumns: [] });
      const [hook] = await db.insert(workbookWebhooks).values({ workbookId: wb.id, tokenHash: `d-${stamp}` }).returning();
      expect(hook).toMatchObject({ enabled: true, lastUsedAt: null });
    });

    it("reads a cell value back exactly as written, including text that looks like JSON", async () => {
      const { wb, cols, rows } = await seed(await workspace("exact"), null, 1, 1);
      const where = and(eq(workbookCells.workbookId, wb.id), eq(workbookCells.rowId, rows[0]!.id), eq(workbookCells.columnId, cols[0]!.id));
      for (const value of ["123", "true", "null", "1e5", '{"a":1}', "[1]", '"quoted"', "00123", "text", 123, 0, true, false, { a: "1" }, ["1"]]) {
        await db.update(workbookCells).set({ value }).where(where);
        const [read] = await db.select({ value: workbookCells.value }).from(workbookCells).where(where);
        expect(read!.value, JSON.stringify(value)).toStrictEqual(value);
        const [raw] = await sql`select jsonb_typeof(value) as kind from workbook_cells where workbook_id = ${wb.id} and row_id = ${rows[0]!.id}`;
        expect(raw!.kind, JSON.stringify(value)).toBe(Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value);
      }
      await db.update(workbookCells).set({ value: null }).where(where);
      const [cleared] = await sql`select value is null as empty from workbook_cells where workbook_id = ${wb.id} and row_id = ${rows[0]!.id}`;
      expect(cleared!.empty).toBe(true);
    });

    it("the public cell selection never returns internal provenance", async () => {
      const { wb, cols, rows } = await seed(await workspace("public"), null, 1, 1);
      const where = and(eq(workbookCells.workbookId, wb.id), eq(workbookCells.rowId, rows[0]!.id), eq(workbookCells.columnId, cols[0]!.id));
      await db.update(workbookCells).set({ foundVia: "skout", internalProvenance: { provider: "managed" } }).where(where);
      const [full] = await db.select().from(workbookCells).where(where);
      expect(full!.internalProvenance).toEqual({ provider: "managed" });
      const [safe] = await db.select(publicWorkbookCellColumns).from(workbookCells).where(where);
      expect(safe).not.toHaveProperty("internalProvenance");
      expect(JSON.stringify(safe)).not.toContain("managed");
    });
  });

  describe("cascades", () => {
    const children = ["workbook_columns", "workbook_rows", "workbook_cells", "workbook_runs", "workbook_imports", "workbook_views", "workbook_webhooks"];
    async function full(label: string) {
      const owner = await user(label);
      const ws = await workspace(label);
      const s = await seed(ws, owner);
      await db.insert(workbookRuns).values({ workbookId: s.wb.id, columnId: s.cols[0]!.id, scope: "all", startedBy: owner });
      const [imported] = await db.insert(workbookImports).values({ workbookId: s.wb.id, sourceType: "csv" }).returning();
      await db.insert(workbookImportIssues).values({ importId: imported!.id, record: 1, line: 2, kind: "invalid", reason: "r", values: ["v"] });
      await db.insert(workbookViews).values({ workbookId: s.wb.id, name: "v" });
      await db.insert(workbookWebhooks).values({ workbookId: s.wb.id, tokenHash: `${label}-${stamp}` });
      return { ...s, ws, owner };
    }

    const issuesOf = async (workbookId: string) =>
      Number((await sql`select count(*)::int as n from workbook_import_issues x join workbook_imports i on i.id = x.import_id where i.workbook_id = ${workbookId}`)[0]!.n);

    it("deleting a workbook removes everything under it and nothing else", async () => {
      const gone = await full("c-wb");
      const kept = await full("c-wb-kept");
      await db.delete(workbooks).where(eq(workbooks.id, gone.wb.id));
      for (const t of children) {
        expect(await countFor(t, gone.wb.id), t).toBe(0);
        expect(await countFor(t, kept.wb.id), t).toBeGreaterThan(0);
      }
      expect(Number((await sql`select count(*)::int as n from workbook_import_issues x where not exists (select 1 from workbook_imports i where i.id = x.import_id)`)[0]!.n)).toBe(0);
      expect(await issuesOf(kept.wb.id)).toBe(1);
    });

    it("deleting a column removes its cells and runs only", async () => {
      const s = await full("c-col");
      await db.delete(workbookColumns).where(eq(workbookColumns.id, s.cols[0]!.id));
      expect(await countFor("workbook_cells", s.wb.id)).toBe(s.rows.length);
      expect(await countFor("workbook_runs", s.wb.id)).toBe(0);
      expect(await countFor("workbook_rows", s.wb.id)).toBe(s.rows.length);
    });

    it("deleting a row removes its cells only", async () => {
      const s = await full("c-row");
      await db.delete(workbookRows).where(eq(workbookRows.id, s.rows[0]!.id));
      expect(await countFor("workbook_cells", s.wb.id)).toBe((s.rows.length - 1) * s.cols.length);
      expect(await countFor("workbook_columns", s.wb.id)).toBe(s.cols.length);
    });

    it("deleting a user keeps the workbook and runs, with the person cleared", async () => {
      const s = await full("c-user");
      await sql`delete from users where id = ${s.owner}`;
      const [wb] = await db.select().from(workbooks).where(eq(workbooks.id, s.wb.id));
      const [run] = await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, s.wb.id));
      expect(wb!.createdBy).toBeNull();
      expect(run!.startedBy).toBeNull();
    });

    it("deleting a workspace removes its workbooks", async () => {
      const s = await full("c-ws");
      await sql`delete from workspaces where id = ${s.ws}`;
      expect(await db.select().from(workbooks).where(eq(workbooks.id, s.wb.id))).toHaveLength(0);
      expect(await countFor("workbook_cells", s.wb.id)).toBe(0);
    });
  });

  describe("legacy workbook tables", () => {
    it("still exist, and no foreign key connects them with Workbooks V2 in either direction", async () => {
      const found = await sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = any(${LEGACY})`;
      expect(found).toHaveLength(LEGACY.length);
      const links = await sql`
        select conname from pg_constraint
        where contype = 'f' and (
          (conrelid::regclass::text = any(${LEGACY}) and confrelid::regclass::text = any(${NAMES})) or
          (conrelid::regclass::text = any(${NAMES}) and confrelid::regclass::text = any(${LEGACY})))`;
      expect(links).toEqual([]);
    });
  });
});
