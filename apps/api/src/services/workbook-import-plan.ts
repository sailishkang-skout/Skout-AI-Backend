import { normalizeDomain, normalizeEmail } from "@skout/shared";
import { normalizeInputValue, type CellScalar, type InputDataType } from "./workbook-cell-values.js";
import { shapeProblem, type CsvDelimiter, type CsvHeader } from "./workbook-import-csv.js";
import { normalizeLinkedinId } from "./enrichment/capture-identity.js";

/**
 * Which file column goes into which workbook column, and what happens to each row (WB2-020). Pure functions: no
 * database or files.
 */
export const DEDUPE_KEYS = ["email", "linkedin_url", "domain", "none"] as const;
export type DedupeKey = (typeof DEDUPE_KEYS)[number];
export type MatchKey = Exclude<DedupeKey, "none">;

/** The column types a deduplication key can be read from. Files often arrive as plain text. */
const KEY_COLUMN_TYPES: Record<MatchKey, InputDataType[]> = {
  email: ["email", "text"],
  linkedin_url: ["linkedin_url", "url", "text"],
  domain: ["domain", "url", "text"],
};

const KEY_LABEL: Record<MatchKey, string> = { email: "email", linkedin_url: "LinkedIn URL", domain: "domain" };

const TYPE_LABEL: Record<InputDataType, string> = {
  text: "text",
  number: "number",
  email: "email address",
  url: "web address",
  linkedin_url: "LinkedIn URL",
  domain: "domain",
  phone: "phone number",
  date: "date (YYYY-MM-DD)",
  checkbox: "true or false value",
};

export interface ColumnMapping {
  /** Position of the column in the file, from 0. */
  header: number;
  columnId?: string;
  newColumn?: { name: string; dataType: InputDataType };
}

export interface DedupeChoice {
  key: DedupeKey;
  /** Which file column holds the key. Needed only when more than one mapped column could. */
  header?: number;
}

export interface ExistingColumn {
  id: string;
  name: string;
  type: string;
  dataType: InputDataType;
}

export interface MappingProblem {
  /** e.g. `columns.2` or `dedupe`. */
  path: string;
  code:
    | "NOTHING_MAPPED"
    | "UNKNOWN_HEADER"
    | "HEADER_MAPPED_TWICE"
    | "UNKNOWN_COLUMN"
    | "NOT_AN_INPUT_COLUMN"
    | "COLUMN_MAPPED_TWICE"
    | "COLUMN_NAME_IN_USE"
    | "COLUMN_LIMIT_EXCEEDED"
    | "DEDUPE_COLUMN_REQUIRED"
    | "DEDUPE_COLUMN_AMBIGUOUS"
    | "DEDUPE_COLUMN_INVALID";
  message: string;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Everything wrong with a mapping, so it can be corrected in one go. Nothing is guessed: a mapping that could mean two
 * things is refused, and so is one that would put two file columns into one cell.
 */
export function checkMapping(
  headers: string[],
  columns: ExistingColumn[],
  mapping: ColumnMapping[],
  dedupe: DedupeChoice,
  maxColumns: number
): { problems: MappingProblem[]; keyHeader: number | null } {
  const problems: MappingProblem[] = [];
  const problem = (path: string, code: MappingProblem["code"], message: string) => problems.push({ path, code, message });
  if (!mapping.length) problem("columns", "NOTHING_MAPPED", "Choose at least one column of the file to import.");

  const byId = new Map(columns.map((c) => [c.id, c]));
  const seenHeaders = new Set<number>();
  const seenColumns = new Set<string>();
  const newNames: string[] = [];
  /** What each usable mapped header lands in. */
  const targets = new Map<number, InputDataType>();

  mapping.forEach((m, i) => {
    const path = `columns.${i}`;
    if (m.header >= headers.length) return problem(path, "UNKNOWN_HEADER", "The file has no such column.");
    if (seenHeaders.has(m.header)) return problem(path, "HEADER_MAPPED_TWICE", `“${headers[m.header]}” is mapped twice.`);
    seenHeaders.add(m.header);
    if (m.columnId !== undefined) {
      const id = m.columnId.toLowerCase();
      const column = byId.get(id);
      if (!column) return problem(path, "UNKNOWN_COLUMN", "This workbook has no such column.");
      if (column.type !== "input") return problem(path, "NOT_AN_INPUT_COLUMN", `“${column.name}” is not a column that can be imported into.`);
      if (seenColumns.has(id)) return problem(path, "COLUMN_MAPPED_TWICE", `Two file columns point at “${column.name}”. Choose one.`);
      seenColumns.add(id);
      targets.set(m.header, column.dataType);
    } else if (m.newColumn) {
      const name = m.newColumn.name;
      const taken = columns.find((c) => sameName(c.name, name));
      if (taken) return problem(path, "COLUMN_NAME_IN_USE", `This workbook already has a column named “${taken.name}”. Map to it, or use another name.`);
      if (newNames.some((other) => sameName(other, name))) return problem(path, "COLUMN_NAME_IN_USE", `Two new columns are named “${name.trim()}”.`);
      newNames.push(name);
      targets.set(m.header, m.newColumn.dataType);
    }
  });

  if (columns.length + newNames.length > maxColumns) {
    problem("columns", "COLUMN_LIMIT_EXCEEDED", `A workbook can have ${maxColumns} columns. This one has ${columns.length}; ${newNames.length} new ones do not fit.`);
  }

  if (dedupe.key === "none") return { problems, keyHeader: null };
  const key = dedupe.key;
  const label = KEY_LABEL[key];
  if (dedupe.header !== undefined) {
    const type = targets.get(dedupe.header);
    if (type === undefined) problem("dedupe", "DEDUPE_COLUMN_INVALID", `The column chosen for the ${label} is not being imported.`);
    else if (!KEY_COLUMN_TYPES[key].includes(type)) problem("dedupe", "DEDUPE_COLUMN_INVALID", `A ${TYPE_LABEL[type]} column cannot be used as the ${label} key.`);
    return { problems, keyHeader: dedupe.header };
  }
  const exact = [...targets].filter(([, type]) => type === key).map(([header]) => header);
  if (exact.length === 1) return { problems, keyHeader: exact[0]! };
  if (exact.length > 1) problem("dedupe", "DEDUPE_COLUMN_AMBIGUOUS", `More than one ${label} column is mapped. Choose which one identifies a duplicate.`);
  else problem("dedupe", "DEDUPE_COLUMN_REQUIRED", `Map a file column to a ${label} column, or choose which column holds the ${label}.`);
  return { problems, keyHeader: null };
}

/**
 * The form of a deduplication value two spellings of the same thing share, or null when it is not a usable one.
 * Email and domain use the platform's identity rules (`@skout/shared`).
 */
export function dedupeValue(key: MatchKey, raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (key === "email") {
    const cell = normalizeInputValue(text, "email");
    return cell.kind === "value" && !cell.errorCode ? normalizeEmail(text) : null;
  }
  if (key === "domain") {
    const domain = normalizeDomain(text);
    const cell = normalizeInputValue(domain, "domain");
    return cell.kind === "value" && !cell.errorCode ? domain : null;
  }
  const cell = normalizeInputValue(text, "linkedin_url");
  if (cell.kind !== "value" || cell.errorCode) return null;
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  const parts = url.pathname.split("/").filter(Boolean).map(normalizeLinkedinId);
  // Scheme, `www.`, country sub-domains, tracking parameters, a trailing slash and (for a profile, company or school)
  // anything after the name, such as a language suffix, all point at the same page.
  return (["in", "company", "school"].includes(parts[0]!) ? parts.slice(0, 2) : parts).join("/");
}

export interface PlannedColumn {
  header: number;
  columnId: string;
  name: string;
  dataType: InputDataType;
}

/** A confirmed import, as stored on the import record. */
export interface ImportPlan {
  headers: string[];
  delimiter: CsvDelimiter;
  columns: PlannedColumn[];
  dedupe: { key: "none" } | { key: MatchKey; header: number; columnId: string };
  /** The request that confirmed it, recorded on the activity entry. */
  requestId: string | null;
}

export type ClassifiedRow =
  | { kind: "ready"; cells: Array<{ columnId: string; value: CellScalar }>; key: string | null }
  | { kind: "invalid" | "malformed" | "skipped"; reason: string };

/**
 * What happens to one row, before duplicates are considered. A row is imported only when every mapped value fits its
 * column: nothing is dropped from a row quietly, it is imported whole or reported whole.
 */
export function classifyRow(plan: ImportPlan, values: string[]): ClassifiedRow {
  const shape = shapeProblem(values, plan.headers.length);
  if (shape) return { kind: "malformed", reason: shape };
  const cells: Array<{ columnId: string; value: CellScalar }> = [];
  const problems: string[] = [];
  for (const column of plan.columns) {
    const cell = normalizeInputValue(values[column.header], column.dataType);
    if (cell.kind === "rejected") problems.push(`${column.name}: ${cell.reason}`);
    else if (cell.kind === "value") {
      if (cell.errorCode) problems.push(`${column.name}: not a valid ${TYPE_LABEL[column.dataType]}`);
      else cells.push({ columnId: column.columnId, value: cell.value });
    }
  }
  if (problems.length) return { kind: "invalid", reason: `Invalid field value. ${problems.join("; ")}` };
  if (!cells.length) return { kind: "skipped", reason: "Missing value: every mapped column is empty in this row" };
  if (plan.dedupe.key === "none") return { kind: "ready", cells, key: null };
  const { key, header } = plan.dedupe;
  const raw = values[header]!;
  // An empty key matches nothing, so the row is imported.
  if (!raw.trim()) return { kind: "ready", cells, key: null };
  const value = dedupeValue(key, raw);
  if (value === null) {
    const name = plan.columns.find((c) => c.header === header)!.name;
    return { kind: "invalid", reason: `Invalid field value. ${name}: not a valid ${KEY_LABEL[key]}, so it cannot be checked for duplicates` };
  }
  return { kind: "ready", cells, key: value };
}

export const duplicateReason = (key: MatchKey) => `Duplicate ${KEY_LABEL[key]}: already in the workbook or earlier in this file`;

// ── Suggestions ──────────────────────────────────────────────────────────────

/** Header spellings that mean the same thing. */
const SAME_AS: string[][] = [
  ["email", "emailaddress", "workemail", "mail"],
  ["linkedin", "linkedinurl", "linkedinprofile", "linkedinprofileurl", "personlinkedinurl"],
  ["domain", "companydomain", "website", "companywebsite", "websiteurl"],
  ["phone", "phonenumber", "mobile", "mobilephone", "mobilenumber"],
  ["firstname", "first"],
  ["lastname", "last", "surname"],
  ["fullname", "name", "contactname"],
  ["company", "companyname", "organization", "organisation", "account"],
  ["title", "jobtitle", "position"],
];

const flat = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const meaning = (name: string) => SAME_AS.findIndex((group) => group.includes(flat(name)));

/** The type a new column should start as: the most specific one every value fits. */
export function suggestedType(header: Pick<CsvHeader, "name" | "fits">): InputDataType {
  const name = flat(header.name);
  const fits = (type: InputDataType) => header.fits.includes(type);
  for (const type of ["email", "linkedin_url"] as const) if (fits(type)) return type;
  if (fits("url")) return "url";
  // Plenty of text looks like a domain or a phone number ("a.smith", "2024001"), so the header must say so too.
  if (fits("domain") && /domain|website/.test(name)) return "domain";
  if (fits("phone") && /phone|mobile|telephone/.test(name)) return "phone";
  for (const type of ["date", "checkbox", "number"] as const) if (fits(type)) return type;
  return "text";
}

export interface HeaderSuggestion {
  header: number;
  /** Null: the column is not imported unless the person chooses. */
  target: { columnId: string } | { newColumn: { name: string; dataType: InputDataType } } | null;
}

/**
 * A starting mapping from the header names. Columns with the same name are matched first, then names that mean the same
 * thing when exactly one workbook column and one file column share that meaning and the values fit. Anything else is
 * offered as a new column.
 */
export function suggestMapping(headers: CsvHeader[], columns: ExistingColumn[], maxColumns: number, maxName: number): HeaderSuggestion[] {
  const inputs = columns.filter((c) => c.type === "input");
  const chosen = new Map<number, string>();
  const used = new Set<string>();
  const take = (header: number, columnId: string) => {
    chosen.set(header, columnId);
    used.add(columnId);
  };
  for (const header of headers) {
    const matches = inputs.filter((c) => !used.has(c.id) && flat(header.name) !== "" && flat(c.name) === flat(header.name));
    if (matches.length === 1) take(header.index, matches[0]!.id);
  }
  for (const header of headers) {
    const group = meaning(header.name);
    if (chosen.has(header.index) || group < 0) continue;
    const columnsLike = inputs.filter((c) => !used.has(c.id) && meaning(c.name) === group);
    const headersLike = headers.filter((h) => !chosen.has(h.index) && meaning(h.name) === group);
    if (columnsLike.length === 1 && headersLike.length === 1 && header.fits.includes(columnsLike[0]!.dataType)) take(header.index, columnsLike[0]!.id);
  }

  const names = columns.map((c) => c.name);
  let room = maxColumns - columns.length;
  return headers.map((header) => {
    const columnId = chosen.get(header.index);
    if (columnId) return { header: header.index, target: { columnId } };
    const name = header.name.slice(0, maxName).trim();
    // No name, no values, a name already taken or no room: leave it to the person.
    if (!name || !header.filled || room <= 0 || names.some((other) => sameName(other, name))) return { header: header.index, target: null };
    names.push(name);
    room -= 1;
    return { header: header.index, target: { newColumn: { name, dataType: suggestedType(header) } } };
  });
}
