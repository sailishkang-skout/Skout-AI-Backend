import { open } from "node:fs/promises";
import { MAX_IMPORT_BYTES, MAX_IMPORT_HEADERS, MAX_IMPORT_ROWS, csvRecords } from "./workbook-import-csv.js";
import { columnLetters, getRows, type SheetTab } from "./google-sheets.client.js";

/**
 * A copy of one tab as a CSV file (WB2-025), so that an import reads a sheet that doesn't change under it, and the CSV
 * import's own chunking, deduplication, progress and report apply. Row 1 names the columns. Each later row of the sheet
 * becomes one line, an empty row an empty line, so a row's position in the sheet is kept.
 */
export class SheetContentError extends Error {
  constructor(
    readonly reason: "NO_HEADERS" | "TOO_MANY_COLUMNS" | "TOO_MANY_ROWS" | "TOO_LARGE",
    message: string
  ) {
    super(message);
    this.name = "SheetContentError";
  }
}

/** Cells asked for at a time, within these row counts. */
const CELLS_PER_READ = 100_000;
const MIN_READ_ROWS = 200;
const MAX_READ_ROWS = 5_000;
const HEADER_MAX = 200;

/**
 * A value as the copy keeps it. Line breaks inside a cell are all written as a line feed, as Sheets writes them, so the
 * reader counts one line for each and a row's position stays right.
 */
const clean = (value: string) => value.replaceAll("\u0000", "").replace(/\r\n?/g, "\n");
/** Every value quoted, and nothing about it changed. */
const line = (values: string[]) => `${values.map((v) => `"${clean(v).replace(/"/g, '""')}"`).join(",")}\r\n`;

/** A name for every column up to the last one with a heading, each different from the others. */
export function headerNames(row: string[]): string[] {
  let width = row.length;
  while (width && !clean(row[width - 1] ?? "").trim()) width -= 1;
  const taken = new Set<string>();
  return Array.from({ length: width }, (_, i) => {
    const letters = columnLetters(i + 1);
    const given = clean(row[i] ?? "").replace(/\s+/g, " ").trim().slice(0, HEADER_MAX - 10);
    let name = given || `Column ${letters}`;
    if (taken.has(name.toLowerCase())) name = `${name} (${letters})`;
    taken.add(name.toLowerCase());
    return name;
  });
}

/** Writes the tab to `file` and answers its headings, its rows with something in them and its size. */
export async function snapshotTab(accessToken: string, spreadsheetId: string, tab: SheetTab, file: string): Promise<{ headers: string[]; rows: number; bytes: number }> {
  if (!tab.rows || !tab.columns) throw new SheetContentError("NO_HEADERS", "This tab is empty. The first row must name the columns.");
  const readable = Math.min(tab.columns, MAX_IMPORT_HEADERS + 1);
  const headers = headerNames((await getRows(accessToken, spreadsheetId, tab.name, 1, 1, readable))[0] ?? []);
  if (!headers.length) throw new SheetContentError("NO_HEADERS", "The first row of the tab must name the columns.");
  if (headers.length > MAX_IMPORT_HEADERS) {
    throw new SheetContentError("TOO_MANY_COLUMNS", `The tab has more than ${MAX_IMPORT_HEADERS} columns.`);
  }
  const size = Math.max(MIN_READ_ROWS, Math.min(MAX_READ_ROWS, Math.floor(CELLS_PER_READ / headers.length)));
  const out = await open(file, "w", 0o600);
  let rows = 0;
  let bytes = 0;
  try {
    const write = async (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_IMPORT_BYTES) throw new SheetContentError("TOO_LARGE", `The tab holds more than ${MAX_IMPORT_BYTES / 1024 / 1024} MB of text. Split it into smaller tabs.`);
      await out.write(text);
    };
    await write(line(headers));
    // Empty rows are written only once a later row shows they are not just the end of the grid.
    let empty = 0;
    for (let from = 2; from <= tab.rows; from += size) {
      const to = Math.min(tab.rows, from + size - 1);
      const found = await getRows(accessToken, spreadsheetId, tab.name, from, to, headers.length);
      let text = "";
      for (const row of found) {
        const values = headers.map((_, i) => row[i] ?? "");
        if (values.every((v) => !v.trim())) {
          empty += 1;
          continue;
        }
        rows += 1;
        if (rows > MAX_IMPORT_ROWS) throw new SheetContentError("TOO_MANY_ROWS", `The tab has more than ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows. Split it into smaller tabs.`);
        text += "\r\n".repeat(empty) + line(values);
        empty = 0;
      }
      empty += to - from + 1 - found.length;
      if (text) await write(text);
    }
  } finally {
    await out.close();
  }
  return { headers, rows, bytes };
}

/** How many columns are checked for having a different value on every row. */
const UNIQUE_CHECKED = 20;

/**
 * Which of the first columns hold a value on every row, no two alike, and so could identify rows. Null where a column
 * was not checked.
 */
export async function uniqueColumns(file: string, columns: number): Promise<Array<boolean | null>> {
  const seen = Array.from({ length: Math.min(columns, UNIQUE_CHECKED) }, () => new Set<string>() as Set<string> | null);
  let header = true;
  for await (const { values } of csvRecords(file, ",")) {
    if (header) {
      header = false;
      continue;
    }
    for (let i = 0; i < seen.length; i += 1) {
      const set = seen[i];
      if (!set) continue;
      const value = (values[i] ?? "").trim();
      if (!value || set.has(value)) seen[i] = null;
      else set.add(value);
    }
  }
  return Array.from({ length: columns }, (_, i) => (i < seen.length ? seen[i] !== null : null));
}
