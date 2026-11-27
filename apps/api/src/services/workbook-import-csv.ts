import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform, pipeline } from "node:stream";
import { parse } from "csv-parse";
import { INPUT_DATA_TYPES, normalizeInputValue, type InputDataType } from "./workbook-cell-values.js";

/**
 * Reading an uploaded CSV file (WB2-020). The file is only ever read as text: nothing in it is evaluated.
 *
 * Parsing is strict about quoting. A misplaced or unclosed quote makes it impossible to say where one row ends and the
 * next begins, so the whole file is refused with the line to look at, rather than rows being merged without anyone
 * knowing. A row that parses but has the wrong number of values is a single bad row, reported on its own.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
export const MAX_IMPORT_HEADERS = 500;
export const PREVIEW_ROWS = 20;
export const PREVIEW_VALUE_LENGTH = 300;
/** One row, quotes included. An unclosed quote stops here instead of reading the rest of the file into memory. */
const MAX_RECORD_BYTES = 1_000_000;

export const CSV_DELIMITERS = [",", ";", "\t"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export type CsvProblem = "EMPTY_FILE" | "NOT_A_CSV" | "INVALID_ENCODING" | "MALFORMED_CSV" | "INVALID_HEADERS" | "NO_DATA_ROWS" | "TOO_MANY_ROWS";

export class CsvFileError extends Error {
  constructor(
    readonly reason: CsvProblem,
    message: string,
    readonly line?: number
  ) {
    super(message);
    this.name = "CsvFileError";
  }
}

export interface CsvRecord {
  /** The line of the file the row starts on, from 1. */
  line: number;
  values: string[];
}

const SIGNATURES: Array<{ bytes: number[]; reason: CsvProblem; message: string }> = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], reason: "NOT_A_CSV", message: "This is an Excel (.xlsx) or zip file, not a CSV. Save it as CSV and upload that." },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], reason: "NOT_A_CSV", message: "This is an old Excel (.xls) file, not a CSV. Save it as CSV and upload that." },
  { bytes: [0x25, 0x50, 0x44, 0x46], reason: "NOT_A_CSV", message: "This is a PDF, not a CSV." },
  { bytes: [0x1f, 0x8b], reason: "NOT_A_CSV", message: "This is a compressed file, not a CSV. Unzip it and upload the CSV." },
  { bytes: [0xff, 0xfe], reason: "INVALID_ENCODING", message: "This file is saved as UTF-16. Save it as “CSV UTF-8” and upload it again." },
  { bytes: [0xfe, 0xff], reason: "INVALID_ENCODING", message: "This file is saved as UTF-16. Save it as “CSV UTF-8” and upload it again." },
];

const NOT_TEXT = "This file is not a text CSV file.";
const NOT_UTF8 = "This file is not UTF-8 text. In Excel, save it as “CSV UTF-8” and upload it again.";

/** Refuses bytes that are not UTF-8 text as they stream past. */
function textOnly(): Transform {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (chunk.includes(0)) return done(new CsvFileError("NOT_A_CSV", NOT_TEXT));
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        return done(new CsvFileError("INVALID_ENCODING", NOT_UTF8));
      }
      done(null, chunk);
    },
    flush(done) {
      try {
        decoder.decode();
      } catch {
        return done(new CsvFileError("INVALID_ENCODING", NOT_UTF8));
      }
      done();
    },
  });
}

const lineBreaks = (values: string[]) => values.reduce((n, v) => n + (v.includes("\n") || v.includes("\r") ? v.match(/\r\n|\r|\n/g)!.length : 0), 0);

function parserError(error: unknown, lastLine: number): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const line = (error as { lines?: number } | null)?.lines;
  if (code === "CSV_QUOTE_NOT_CLOSED") {
    return new CsvFileError("MALFORMED_CSV", `A quoted value that starts after line ${lastLine} is never closed. Close the quote and upload the file again.`, lastLine + 1);
  }
  if (code === "CSV_INVALID_CLOSING_QUOTE" || code === "INVALID_OPENING_QUOTE") {
    return new CsvFileError(
      "MALFORMED_CSV",
      `Line ${line}: a quote is in the wrong place. Put quotes around the whole value, double any quote inside it, and upload the file again.`,
      line
    );
  }
  if (code === "CSV_MAX_RECORD_SIZE") {
    return new CsvFileError("MALFORMED_CSV", `A row starting after line ${lastLine} is longer than 1 MB. Check for a quote that is never closed.`, lastLine + 1);
  }
  return error;
}

/** Every non-blank record of the file in order, the header line first. Holds only a small buffer in memory. */
export async function* csvRecords(path: string, delimiter: CsvDelimiter): AsyncGenerator<CsvRecord> {
  const source = createReadStream(path);
  const parser = parse({
    bom: true,
    delimiter,
    record_delimiter: ["\r\n", "\n", "\r"],
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: MAX_RECORD_BYTES,
    info: true,
  });
  // `pipeline` hands any read, encoding or parsing error to the loop below.
  pipeline(source, textOnly(), parser, () => {});
  let lastLine = 0;
  try {
    for await (const item of parser as AsyncIterable<{ record: string[]; info: { lines: number } }>) {
      const { record, info } = item;
      lastLine = info.lines;
      // A line holding only spaces is a blank line.
      if (record.length === 1 && record[0]!.trim() === "") continue;
      yield { line: info.lines - lineBreaks(record), values: record };
    }
  } catch (error) {
    throw parserError(error, lastLine);
  } finally {
    source.destroy();
  }
}

/** The separator the header line uses: comma, semicolon (common in European spreadsheets) or tab. */
export function detectDelimiter(start: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of start.replace(/^\uFEFF/, "").replace(/^[\r\n]+/, "")) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as CsvDelimiter] += 1;
  }
  return CSV_DELIMITERS.reduce<CsvDelimiter>((best, d) => (counts[d] > counts[best] ? d : best), ",");
}

async function startOfFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** Stricter than what a cell accepts, so a column is only offered a type when nothing would be lost or rejected. */
function suggests(type: InputDataType, value: string): boolean {
  const text = value.trim();
  // A leading zero (postcodes, account codes) or more digits than a number holds exactly stays text.
  if (type === "number") return /^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(text);
  if (type === "checkbox") return /^(true|false|yes|no)$/i.test(text);
  const cell = normalizeInputValue(value, type);
  return cell.kind === "value" && cell.errorCode === null;
}

export interface CsvHeader {
  index: number;
  name: string;
  /** The types every non-empty value in this column fits. Always includes `text`. */
  fits: InputDataType[];
  /** Rows with something in this column. */
  filled: number;
}

export interface PreviewRow {
  line: number;
  values: string[];
  /** Why this row cannot be imported whatever the mapping. */
  problem?: string;
}

export interface CsvInspection {
  delimiter: CsvDelimiter;
  headers: CsvHeader[];
  totalRows: number;
  preview: PreviewRow[];
}

/** Why a row has the wrong shape, or null. Extra values that are all empty are ignored. */
export function shapeProblem(values: string[], headers: number): string | null {
  if (values.length === headers || (values.length > headers && values.slice(headers).every((v) => v.trim() === ""))) return null;
  return `Malformed CSV row: expected ${headers} values, found ${values.length}`;
}

/** Reads the whole file once: checks it, counts its rows, and keeps the first ones for the preview. */
export async function inspectCsv(path: string): Promise<CsvInspection> {
  const start = await startOfFile(path);
  if (!start.length) throw new CsvFileError("EMPTY_FILE", "The file is empty.");
  const signature = SIGNATURES.find((s) => s.bytes.every((byte, i) => start[i] === byte));
  if (signature) throw new CsvFileError(signature.reason, signature.message);
  if (start.includes(0) || /^\s*<(!doctype|html|\?xml)/i.test(start.subarray(0, 200).toString("utf8").replace(/^\uFEFF/, ""))) {
    throw new CsvFileError("NOT_A_CSV", NOT_TEXT);
  }
  const delimiter = detectDelimiter(start.toString("utf8"));

  let headers: Array<CsvHeader & { candidates: InputDataType[] }> | null = null;
  const preview: PreviewRow[] = [];
  let totalRows = 0;
  for await (const { line, values } of csvRecords(path, delimiter)) {
    if (!headers) {
      if (values.length > MAX_IMPORT_HEADERS) throw new CsvFileError("INVALID_HEADERS", `The file has ${values.length} columns; the most that can be read is ${MAX_IMPORT_HEADERS}.`, line);
      if (values.every((v) => v.trim() === "")) throw new CsvFileError("INVALID_HEADERS", "The first line must name the columns.", line);
      headers = values.map((v, index) => ({ index, name: v.trim(), fits: [], filled: 0, candidates: INPUT_DATA_TYPES.filter((t) => t !== "text") }));
      continue;
    }
    totalRows += 1;
    if (totalRows > MAX_IMPORT_ROWS) {
      throw new CsvFileError("TOO_MANY_ROWS", `The file has more than ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows. Split it into smaller files.`);
    }
    const problem = shapeProblem(values, headers.length);
    if (preview.length < PREVIEW_ROWS) {
      preview.push({ line, values: values.slice(0, headers.length).map((v) => v.slice(0, PREVIEW_VALUE_LENGTH)), ...(problem ? { problem } : {}) });
    }
    if (problem) continue;
    for (const header of headers) {
      const value = values[header.index]!;
      if (value.trim() === "") continue;
      header.filled += 1;
      if (header.candidates.length) header.candidates = header.candidates.filter((type) => suggests(type, value));
    }
  }
  if (!headers) throw new CsvFileError("EMPTY_FILE", "The file is empty.");
  if (!totalRows) throw new CsvFileError("NO_DATA_ROWS", "The file has a header line but no rows.");
  return {
    delimiter,
    totalRows,
    preview,
    headers: headers.map(({ candidates, index, name, filled }) => ({ index, name, filled, fits: ["text", ...(filled ? candidates : [])] as InputDataType[] })),
  };
}

/**
 * One value in a file a person will open in a spreadsheet: always quoted, and a value a spreadsheet would run as a
 * formula is prefixed so it stays text (PRD EXP-2, SEC-9).
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const csvLine = (values: string[]) => `${values.map(csvCell).join(",")}\r\n`;
