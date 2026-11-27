import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { columnLetters } from "./google-sheets.client.js";
import { identifier } from "./workbook-sheet-identity.js";
import { headerNames, snapshotTab, uniqueColumns } from "./workbook-sheet-snapshot.js";
import { parseSpreadsheetLink } from "./workbook-sheets.service.js";
import { csvRecords } from "./workbook-import-csv.js";

/** The pure parts of the Google Sheets row source (WB2-025). */
afterEach(() => vi.unstubAllGlobals());

describe("column letters", () => {
  it.each([[1, "A"], [26, "Z"], [27, "AA"], [52, "AZ"], [53, "BA"], [500, "SF"], [702, "ZZ"], [703, "AAA"]])("names column %i %s", (n, letters) => {
    expect(columnLetters(n)).toBe(letters);
  });
});

describe("spreadsheet links", () => {
  const id = "1AbC-dEf_GhIjKlMnOpQrStUvWxYz0123456789";
  it.each([
    [`https://docs.google.com/spreadsheets/d/${id}/edit#gid=1234`, 1234],
    [`https://docs.google.com/spreadsheets/d/${id}/edit?gid=7#gid=7`, 7],
    [`https://docs.google.com/spreadsheets/d/${id}?gid=0`, 0],
    [`  https://docs.google.com/spreadsheets/d/${id}  `, null],
    [id, null],
  ])("reads %s", (link, sheetId) => {
    expect(parseSpreadsheetLink(link)).toEqual({ spreadsheetId: id, sheetId });
  });
  it("ignores a tab number that isn't one", () => {
    expect(parseSpreadsheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=abc`)).toEqual({ spreadsheetId: id, sheetId: null });
  });
});

describe("headings", () => {
  it("drops empty ones at the end only, and keeps every name different", () => {
    expect(headerNames(["a", "", "A", "", ""])).toEqual(["a", "Column B", "A (C)"]);
    expect(headerNames(["", ""])).toEqual([]);
    expect(headerNames(["x".repeat(500)])[0]!.length).toBeLessThanOrEqual(200);
  });
});

describe("row identity", () => {
  it("does not depend on where a row is", () => {
    const keys = (rows: string[][]) => rows.map(identifier({ kind: "content", headers: [1, 0] })).map((r) => r.key).sort();
    expect(keys([["a", "b"], ["c", "d"], ["a", "b"]])).toEqual(keys([["c", "d"], ["a ", " b"], ["a", "b"]]));
    expect(new Set(keys([["a", "b"], ["a", "b"]])).size).toBe(2);
    expect(keys([["a", "b"]])).not.toEqual(keys([["b", "a"]]));
    // Columns that don't identify a row don't change it.
    expect(keys([["a", "b", "note"]])).toEqual(keys([["a", "b", "other"]]));
  });
  it("by ID, knows empty and repeated ones", () => {
    const of = identifier({ kind: "id", header: 0 });
    const first = of([" 7 ", "x"]);
    expect(of(["7", "y"])).toEqual({ key: first.key, repeated: true });
    expect(of(["", "y"])).toEqual({ key: null, repeated: false });
    expect(first.repeated).toBe(false);
    expect(first.key).not.toContain("7 ");
  });
});

describe("the copy of a tab", () => {
  /** Google, serving `values` and leaving out trailing empty rows as it does. */
  function serve(values: string[][]) {
    const ranges: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const range = decodeURIComponent(new URL(url).pathname.split("/values/")[1]!);
      ranges.push(range);
      const [, from, to] = /!A(\d+):[A-Z]+(\d+)$/.exec(range)!;
      const rows = values.slice(Number(from) - 1, Number(to));
      while (rows.length && !rows[rows.length - 1]!.length) rows.pop();
      return new Response(JSON.stringify(rows.length ? { values: rows } : {}));
    });
    return ranges;
  }
  async function copy(values: string[][], rows: number, columns = 2) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wb2-sheet-"));
    try {
      const ranges = serve(values);
      const file = path.join(dir, "copy.csv");
      const result = await snapshotTab("token", "sheet", { sheetId: 0, name: "T", rows, columns }, file);
      const records = [];
      for await (const r of csvRecords(file, ",")) records.push(r);
      return { ...result, ranges, records, text: await readFile(file, "utf8"), unique: await uniqueColumns(file, result.headers.length) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("reads the grid in blocks to its end, keeping each row's place and every value as it is", async () => {
    const values: string[][] = [["id", "note"], ["1", '=cmd|"x"'], [], ["2"]];
    values[12_000] = ["3", "after a long gap"];
    for (let i = 0; i < 12_000; i += 1) values[i] ??= [];
    const done = await copy(values, 12_500);
    expect(done.rows).toBe(3);
    expect(done.records.map((r) => [r.line, r.values])).toEqual([[1, ["id", "note"]], [2, ["1", '=cmd|"x"']], [4, ["2", ""]], [12_001, ["3", "after a long gap"]]]);
    expect(done.ranges).toEqual(["'T'!A1:B1", "'T'!A2:B5001", "'T'!A5002:B10001", "'T'!A10002:B12500"]);
    // Nothing is written for the empty rows after the last one.
    expect(done.text.endsWith('"after a long gap"\r\n')).toBe(true);
    expect(done.unique).toEqual([true, false]);
  });

  it("writes cell line breaks one way, and drops what a database can't hold", async () => {
    const done = await copy([["a\u0000", "b"], ["x\r\ny\rz", "n\u0000ul"]], 2);
    expect(done.headers).toEqual(["a", "b"]);
    expect(done.records[1]!.values).toEqual(["x\ny\nz", "nul"]);
  });

  it("refuses a tab with no headings", async () => {
    await expect(copy([[], ["a"]], 5)).rejects.toMatchObject({ reason: "NO_HEADERS" });
    await expect(copy([], 0, 0)).rejects.toMatchObject({ reason: "NO_HEADERS" });
  });
});
