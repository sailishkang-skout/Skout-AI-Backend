import { describe, expect, it } from "vitest";
import { COLUMN_COUNT, COLUMN_SPECS, ENRICHMENT_STATE_PER_MILLE, dictionaryRows, insertCellsSql, insertRowsSql, insertWorkbookAndColumnsSql, setupGeneratorDdl } from "./dataset.js";
import { variantByKey } from "./variants.js";

const seed = { tag: "t", workbookId: "11111111-1111-1111-1111-111111111111", workspaceId: "22222222-2222-2222-2222-222222222222", userId: null, name: "x", rows: 100, salt: 3, idBase: 0 };

describe("dataset definition", () => {
  it("is 20 columns covering every PRD column type", () => {
    expect(COLUMN_SPECS).toHaveLength(COLUMN_COUNT);
    expect(COLUMN_SPECS.map((c) => c.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(new Set(COLUMN_SPECS.map((c) => c.type))).toEqual(new Set(["input", "enrichment", "ai", "formula", "action"]));
  });

  it("targets a state mix that sums to 100%", () => {
    expect(Object.values(ENRICHMENT_STATE_PER_MILLE).reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("has dictionaries for every kind the SQL reads", () => {
    const kinds = new Set(dictionaryRows().map((r) => r.kind));
    for (const k of ["first", "last", "cpre", "csuf", "tld", "title", "city", "seniority", "size", "industry", "revenue", "country", "err", "s1", "s2", "s3", "ice"]) expect(kinds.has(k)).toBe(true);
  });

  it("generates the same SQL for the same seed (reproducible) and different SQL for a different salt", () => {
    const v = variantByKey("b");
    expect(insertCellsSql(v, seed)).toBe(insertCellsSql(v, seed));
    expect(insertCellsSql(v, { ...seed, salt: 4 })).not.toBe(insertCellsSql(v, seed));
    expect(insertRowsSql(v, seed)).toBe(insertRowsSql(v, seed));
  });

  it("never uses random() or now() for data values, so a reload is identical", () => {
    for (const key of ["a", "b", "e"]) {
      const v = variantByKey(key);
      const sqlText = [insertCellsSql(v, seed), insertRowsSql(v, seed), ...insertWorkbookAndColumnsSql(v, seed), ...setupGeneratorDdl()].join("\n");
      expect(sqlText).not.toMatch(/\brandom\(\)|\bnow\(\)|gen_random_uuid/);
    }
  });

  it("writes workbook_id on the cell only for variants that have it", () => {
    expect(insertCellsSql(variantByKey("b"), seed)).toContain("(workbook_id, row_id, column_id");
    expect(insertCellsSql(variantByKey("a"), seed)).toContain("(row_id, column_id");
    expect(insertCellsSql(variantByKey("a"), seed)).not.toContain("(workbook_id, row_id");
  });

  it("uses no real provider names in internal provenance", () => {
    const s = insertCellsSql(variantByKey("a"), seed);
    expect(s).toContain("managed_provider_");
    expect(s).not.toMatch(/apollo|hunter\.io|zoominfo|clearbit|pdl|lusha|datagma/i);
  });
});
