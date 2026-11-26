import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, expectTypeOf, it } from "vitest";
import { publicWorkbookCellColumns, workbookCells, type PublicWorkbookCell, type WorkbookCellRecord } from "./workbooks.js";

/** WB2-010 checks that need no database: what may leave the server, and what the migrations are allowed to do. */
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const TAGS = ["workbooks", "columns", "rows", "cells", "runs", "imports", "views", "webhooks"].map((n, i) => `${String(170 + i).padStart(4, "0")}_workbook_v2_${n}`);
const statements = (tag: string) => readFileSync(path.join(drizzleDir, `${tag}.sql`), "utf8").replace(/--(?!>).*$/gm, "");

describe("server-only cell provenance", () => {
  it("the public selection is every cell column except internalProvenance", () => {
    const all = Object.keys(getTableColumns(workbookCells));
    expect(all).toContain("internalProvenance");
    expect(Object.keys(publicWorkbookCellColumns).sort()).toEqual(all.filter((c) => c !== "internalProvenance").sort());
  });

  it("the public cell type has no provenance field; the stored record does", () => {
    expectTypeOf<PublicWorkbookCell>().not.toHaveProperty("internalProvenance");
    expectTypeOf<WorkbookCellRecord>().toHaveProperty("internalProvenance");
  });
});

describe("Workbooks V2 migrations", () => {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };

  it("are journaled once each, in dependency order, after everything that came before them", () => {
    const at = TAGS.map((tag) => journal.entries.findIndex((e) => e.tag === tag));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    const first = at[0]!;
    const earlier = journal.entries.slice(0, first);
    expect(journal.entries[first]!.when).toBeGreaterThan(Math.max(...earlier.map((e) => e.when)));
    // The runner records applied migrations by `when`: a shared value would silently skip one of them.
    for (const i of at) expect(journal.entries.filter((e) => e.when === journal.entries[i]!.when)).toHaveLength(1);
  });

  it("only add things: nothing is dropped, altered, truncated or deleted", () => {
    for (const tag of TAGS) {
      expect(statements(tag), tag).not.toMatch(/\b(DROP|ALTER|TRUNCATE)\b|\bDELETE\s+FROM\b|\bUPDATE\s+"/i);
    }
  });

  it("never name a legacy workbook table", () => {
    for (const tag of TAGS) {
      expect(statements(tag), tag).not.toMatch(/enrichment_workbook|workbook_column_definitions|workbook_column_values/);
    }
  });

  it("create exactly one table each", () => {
    const created = TAGS.map((tag) => [...statements(tag).matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g)].map((m) => m[1]));
    expect(created).toEqual([["workbooks"], ["workbook_columns"], ["workbook_rows"], ["workbook_cells"], ["workbook_runs"], ["workbook_imports"], ["workbook_views"], ["workbook_webhooks"]]);
  });
});
