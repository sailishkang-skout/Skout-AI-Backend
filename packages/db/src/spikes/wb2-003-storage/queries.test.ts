import { describe, expect, it } from "vitest";
import { FILTERS, WINDOW_SIZE, claimSql, completeSql, editCellSql, filteredCountSql, filteredSortedWindowSql, filteredWindowSql, sortedWindowSql, windowSql } from "./queries.js";
import { VARIANTS } from "./variants.js";

describe("access-pattern queries", () => {
  it("never select internal_provenance in a read the browser could receive", () => {
    for (const v of VARIANTS) {
      const reads = [windowSql(v), sortedWindowSql(v), sortedWindowSql(v, "DESC"), filteredSortedWindowSql(v), ...Object.values(FILTERS).flatMap((f) => [filteredWindowSql(v, f), filteredCountSql(v, f)])];
      for (const q of reads) {
        expect(q).not.toContain("internal_provenance");
        expect(q).not.toMatch(/\bc\.\*|\bs\.\*|SELECT \*/);
      }
    }
  });

  it("the window is bounded to 200 rows and ordered by position", () => {
    expect(WINDOW_SIZE).toBe(200);
    for (const v of VARIANTS) {
      expect(windowSql(v)).toContain("LIMIT 200");
      expect(windowSql(v)).toMatch(/ORDER BY position/);
    }
  });

  it("sort and filter happen in SQL, with the window applied by LIMIT/OFFSET", () => {
    for (const v of VARIANTS) {
      expect(sortedWindowSql(v)).toMatch(/ORDER BY s\.value ASC NULLS LAST, r\.position\s+LIMIT 200 OFFSET \$3/);
      expect(filteredWindowSql(v, FILTERS.state_error)).toContain("LIMIT 200 OFFSET $3");
      expect(filteredCountSql(v, FILTERS.state_error)).toContain("count(*)");
    }
  });

  it("a sorted window comes back in sort order, not position order", () => {
    for (const v of VARIANTS) {
      expect(sortedWindowSql(v, "ASC")).toContain("ORDER BY p.sort_key ASC NULLS LAST, p.position, c.column_id");
      expect(sortedWindowSql(v, "DESC")).toContain("ORDER BY p.sort_key DESC NULLS LAST, p.position, c.column_id");
      expect(filteredSortedWindowSql(v)).toContain("ORDER BY p.sort_key NULLS LAST, p.position, c.column_id");
      // plain and filtered windows stay in position order
      expect(windowSql(v)).toMatch(/ORDER BY p\.position, c\.column_id/);
      expect(filteredWindowSql(v, FILTERS.state_error)).toMatch(/ORDER BY p\.position, c\.column_id/);
    }
  });

  it("scope cell reads to the workbook so partitions can be pruned, where the variant has workbook_id", () => {
    for (const v of VARIANTS.filter((x) => x.workbookIdOnCells)) {
      expect(windowSql(v)).toContain("c.workbook_id = $1");
      expect(sortedWindowSql(v)).toContain("s.workbook_id = $1");
    }
    for (const v of VARIANTS.filter((x) => !x.workbookIdOnCells)) expect(windowSql(v)).not.toContain("workbook_id = $1 AND c");
  });

  it("every statement that takes $1 references it, so Postgres can type the parameter", () => {
    for (const v of VARIANTS) {
      for (const q of [claimSql(v), completeSql(v), editCellSql(v)]) expect(q).toContain("$1");
    }
  });

  it("claiming is a compare-and-set that cannot take a cell already running", () => {
    for (const v of VARIANTS) {
      expect(claimSql(v)).toContain("state <> 'running'");
      expect(claimSql(v)).toContain("RETURNING row_id");
      expect(completeSql(v)).toContain("c.state = 'running'");
    }
  });

  it("only is_empty keeps rows that have no matching cell", () => {
    expect(Object.values(FILTERS).filter((f) => f.left).map((f) => f.kind)).toEqual(["is_empty"]);
  });
});
