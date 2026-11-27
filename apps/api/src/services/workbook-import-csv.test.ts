import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CsvFileError, MAX_IMPORT_ROWS, csvCell, csvRecords, detectDelimiter, inspectCsv, shapeProblem, type CsvDelimiter } from "./workbook-import-csv.js";

/** WB2-020: reading an uploaded CSV file. */
let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "wb2-csv-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(content: string | Buffer): Promise<string> {
  const at = path.join(dir, `${++n}.csv`);
  await writeFile(at, content);
  return at;
}

async function records(content: string, delimiter: CsvDelimiter = ",") {
  const out = [];
  for await (const row of csvRecords(await file(content), delimiter)) out.push(row);
  return out;
}

async function refusal(content: string | Buffer): Promise<CsvFileError> {
  try {
    await inspectCsv(await file(content));
  } catch (error) {
    expect(error).toBeInstanceOf(CsvFileError);
    return error as CsvFileError;
  }
  throw new Error("the file was accepted");
}

describe("reading records", () => {
  it("reads quoted values, doubled quotes, separators and line breaks inside a value, and says which line each row starts on", async () => {
    const got = await records('name,note\n"Smith, Ann","said ""hi"""\n"two\nlines",x\nlast,y\n');
    expect(got).toEqual([
      { line: 1, values: ["name", "note"] },
      { line: 2, values: ["Smith, Ann", 'said "hi"'] },
      { line: 3, values: ["two\nlines", "x"] },
      { line: 5, values: ["last", "y"] },
    ]);
  });

  it("accepts Windows, Unix and old Mac line endings, a byte-order mark and no final newline", async () => {
    for (const text of ["\uFEFFa,b\r\n1,2\r\n3,4", "a,b\n1,2\n3,4\n", "a,b\r1,2\r3,4\r", "a,b\r\n1,2\n3,4\r\n"]) {
      expect((await records(text)).map((r) => r.values), JSON.stringify(text)).toEqual([
        ["a", "b"],
        ["1", "2"],
        ["3", "4"],
      ]);
    }
  });

  it("skips blank lines but keeps rows of empty values", async () => {
    const got = await records("a,b\n\n1,2\n   \n,\n\n3,4\n");
    expect(got.map((r) => [r.line, r.values])).toEqual([
      [1, ["a", "b"]],
      [3, ["1", "2"]],
      [5, ["", ""]],
      [7, ["3", "4"]],
    ]);
  });

  it("keeps formulas and markup as plain text", async () => {
    const got = await records('a,b\n"=HYPERLINK(""http://x"")",<script>alert(1)</script>\n');
    expect(got[1]!.values).toEqual(['=HYPERLINK("http://x")', "<script>alert(1)</script>"]);
  });
});

describe("separators", () => {
  it("takes the one the header line uses, ignoring those inside quotes", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a;b;c\n1,5;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
    expect(detectDelimiter('"last, first";email\n')).toBe(";");
    expect(detectDelimiter('\uFEFF\n"a;b",c\n')).toBe(",");
    expect(detectDelimiter("only\nx;y;z")).toBe(",");
  });

  it("reads a semicolon file", async () => {
    const found = await inspectCsv(await file("name;amount\nAnn;1,5\n"));
    expect(found.delimiter).toBe(";");
    expect(found.preview[0]!.values).toEqual(["Ann", "1,5"]);
  });
});

describe("inspecting a file", () => {
  it("returns the headers, the row count and the first 20 rows only", async () => {
    const text = `Name , Email\n${Array.from({ length: 45 }, (_, i) => `p${i},p${i}@x.com`).join("\n")}\n`;
    const found = await inspectCsv(await file(text));
    expect(found.headers.map((h) => [h.index, h.name, h.filled])).toEqual([
      [0, "Name", 45],
      [1, "Email", 45],
    ]);
    expect(found.totalRows).toBe(45);
    expect(found.preview).toHaveLength(20);
    expect(found.preview[0]).toEqual({ line: 2, values: ["p0", "p0@x.com"] });
    expect(found.preview[19]).toEqual({ line: 21, values: ["p19", "p19@x.com"] });
  });

  it("offers a type only when every value in the whole file fits it", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => [
      `p${i}@acme.com`,
      i === 299 ? "n/a" : `q${i}@acme.com`,
      String(i + 1),
      `0${i}123`,
      "https://www.linkedin.com/in/someone",
      "acme.com",
      "2026-01-31",
      "yes",
      "",
    ]);
    const found = await inspectCsv(await file(["good,late bad,count,zip,li,site,day,flag,empty", ...rows.map((r) => r.join(","))].join("\n")));
    const fits = Object.fromEntries(found.headers.map((h) => [h.name, h.fits]));
    expect(fits.good).toContain("email");
    expect(fits["late bad"]).toEqual(["text"]);
    expect(fits.count).toContain("number");
    // A leading zero would be lost as a number.
    expect(fits.zip).not.toContain("number");
    expect(fits.li).toEqual(expect.arrayContaining(["linkedin_url", "url"]));
    expect(fits.site).toContain("domain");
    expect(fits.day).toContain("date");
    expect(fits.flag).toContain("checkbox");
    expect(fits.empty).toEqual(["text"]);
  });

  it("flags rows with the wrong number of values and counts them", async () => {
    const found = await inspectCsv(await file("a,b\n1\n1,2,3\n1,2,,\n4,5\n"));
    expect(found.totalRows).toBe(4);
    expect(found.preview.map((r) => r.problem)).toEqual(["Malformed CSV row: expected 2 values, found 1", "Malformed CSV row: expected 2 values, found 3", undefined, undefined]);
    expect(shapeProblem(["1", "2", " ", ""], 2)).toBeNull();
  });

  it("shortens very long values in the preview only", async () => {
    const found = await inspectCsv(await file(`a\n${"x".repeat(5_000)}\n`));
    expect(found.preview[0]!.values[0]).toHaveLength(300);
  });

  it(`accepts ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows and refuses one more`, async () => {
    const rows = (count: number) => `a\n${"1\n".repeat(count)}`;
    expect((await inspectCsv(await file(rows(MAX_IMPORT_ROWS)))).totalRows).toBe(MAX_IMPORT_ROWS);
    const error = await refusal(rows(MAX_IMPORT_ROWS + 1));
    expect(error.reason).toBe("TOO_MANY_ROWS");
    expect(error.message).toContain("100,000");
  });

  it("does not count the header line or blank lines towards the limit", async () => {
    const found = await inspectCsv(await file(`a\n\n\n${"1\n\n".repeat(MAX_IMPORT_ROWS)}`));
    expect(found.totalRows).toBe(MAX_IMPORT_ROWS);
  });
});

describe("refusing files", () => {
  const latin1 = Buffer.concat([Buffer.from("name\nJos"), Buffer.from([0xe9]), Buffer.from("\n")]);
  const lateBinary = Buffer.concat([Buffer.from(`a\n${"row\n".repeat(40_000)}`), Buffer.from([0, 1, 2])]);
  const lateLatin1 = Buffer.concat([Buffer.from(`a\n${"row\n".repeat(40_000)}`), latin1]);

  it.each([
    ["an empty file", "", "EMPTY_FILE"],
    ["only blank lines", "\n\n  \n", "EMPTY_FILE"],
    ["a header and no rows", "a,b\n", "NO_DATA_ROWS"],
    ["unnamed columns", ",,\n1,2,3\n", "INVALID_HEADERS"],
    ["an Excel workbook", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), "NOT_A_CSV"],
    ["an old Excel file", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1]), "NOT_A_CSV"],
    ["a PDF", "%PDF-1.7\n...", "NOT_A_CSV"],
    ["a gzip file", Buffer.from([0x1f, 0x8b, 0x08]), "NOT_A_CSV"],
    ["a web page", "  <!DOCTYPE html><html></html>", "NOT_A_CSV"],
    ["a program", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]), "NOT_A_CSV"],
    ["binary data far into the file", lateBinary, "NOT_A_CSV"],
    ["UTF-16", Buffer.from("\uFEFFa,b\n1,2\n", "utf16le"), "INVALID_ENCODING"],
    ["Latin-1 text", latin1, "INVALID_ENCODING"],
    ["Latin-1 text far into the file", lateLatin1, "INVALID_ENCODING"],
    ["a character cut off at the end", Buffer.concat([Buffer.from("a\nx"), Buffer.from([0xe2, 0x82])]), "INVALID_ENCODING"],
  ] as const)("refuses %s", async (_name, content, reason) => {
    expect((await refusal(content)).reason).toBe(reason);
  });

  it.each([
    ["a quote inside an unquoted value", 'a,b\n1,2\n3,5" pipe\n7,8\n', 3],
    ["text after a closing quote", 'a,b\n"x"y,2\n3,4\n', 2],
    ["a quote that is never closed", 'a,b\n1,2\n3,"oops\n5,6\n', 3],
    ["a quote closed by a later row, which would merge the rows between", 'a,b\n1,2\n3,"oops\n5,6\n7,"x"\n9,10\n', 5],
  ])("refuses the whole file for %s, naming the line", async (_name, content, line) => {
    const error = await refusal(content);
    expect(error.reason).toBe("MALFORMED_CSV");
    expect(error.line).toBe(line);
    expect(error.message).toMatch(/quote/i);
  });

  it("stops reading a row longer than 1 MB instead of holding the rest of the file", async () => {
    const error = await refusal(`a,b\n1,"${"x\n".repeat(700_000)}`);
    expect(error.reason).toBe("MALFORMED_CSV");
    expect(error.message).toContain("1 MB");
  });

  it("refuses more columns than can be read", async () => {
    expect((await refusal(`${Array.from({ length: 501 }, (_, i) => `h${i}`).join(",")}\n1\n`)).reason).toBe("INVALID_HEADERS");
  });
});

describe("report values", () => {
  it("quotes every value and stops a spreadsheet running one as a formula", () => {
    for (const risky of ["=1+1", "+44 20 7946 0000", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(risky)).toBe(`"'${risky}"`);
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("plain = text")).toBe('"plain = text"');
  });
});
