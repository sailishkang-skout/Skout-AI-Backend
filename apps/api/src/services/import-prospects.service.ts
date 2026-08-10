import OpenAI from "openai";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";
import { generateCompanyId, generateProspectId, normalizeDomain } from "@skout/shared";
import {
  bulkUpsertProspects,
  type OpenSearchConfig,
  type ProspectDocument,
} from "@skout/opensearch";
import type { Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { buildListService } from "./list.service.js";
import { createLogger } from "@skout/observability";

const log = createLogger("import-prospects");

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return (result.text ?? "").trim();
  } finally {
    await parser.destroy();
  }
}

export interface ImportedProspectRow {
  fullName: string;
  companyDomain: string;
  email?: string;
  jobTitle?: string;
  companyName?: string;
  phone?: string;
  linkedinUrl?: string;
  country?: string;
  city?: string;
  /** Company-level field (e.g. from a separate "Accounts" sheet) — shown in preview, not persisted on commit. */
  companyRevenue?: string;
  raw?: Record<string, string>;
}

/** One detected header's target field, or "unmapped" if nothing recognized it. */
export interface DetectedSheet {
  /** Sheet name for XLSX; undefined for CSV/other single-table formats. */
  sheetName?: string;
  headers: string[];
  /** Original header text -> resolved field name (or "unmapped"). */
  mappedHeaders: Record<string, string>;
  rowCount: number;
  /** "accounts" = company-level rows with no name/email (e.g. an Accounts sheet used to enrich contacts by company name). */
  kind: "contacts" | "accounts" | "unknown";
}

export interface ParseImportResult {
  rows: ImportedProspectRow[];
  source: "csv" | "xlsx" | "pdf" | "image" | "ocr" | "svg";
  warnings: string[];
  /** Per-sheet/table header detection — used to build clearer errors and a manual column-mapping UI. */
  sheets?: DetectedSheet[];
}

/** Decode common XML entities used in SVG text nodes. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Extract readable text from an SVG (vision models reject image/svg+xml).
 * Prefers `<text>` node contents; falls back to stripping tags.
 */
function extractSvgText(buffer: Buffer): string {
  const xml = buffer.toString("utf8");
  const texts: string[] = [];
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const inner = decodeXmlEntities(match[1]!.replace(/<[^>]+>/g, "")).trim();
    if (inner) texts.push(inner);
  }
  if (texts.length) return texts.join("\n");
  return decodeXmlEntities(xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function parseSvg(buffer: Buffer): ParseImportResult {
  const text = extractSvgText(buffer);
  if (!text) {
    return {
      rows: [],
      source: "svg",
      warnings: ["SVG had no extractable text — export as PNG/PDF for OCR, or use CSV/Excel"],
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Skip title/banner lines until we find a header that maps to name/email.
  let headerIdx = lines.findIndex((line) => {
    const cols = line.split(/[,;\t]/).map((c) => c.trim().toLowerCase());
    return cols.some((c) => c === "name" || c === "fullname" || c.includes("email") || c === "full name");
  });
  if (headerIdx < 0) headerIdx = 0;

  const sliced = lines.slice(headerIdx).join("\n");
  const parsed = parseDelimited(sliced);
  return {
    rows: parsed.rows,
    source: "svg",
    warnings: parsed.rows.length
      ? parsed.warnings
      : [
          ...parsed.warnings,
          "Could not map SVG text to prospects — use CSV/Excel, or a PNG/PDF for OCR",
        ],
  };
}

/** Fields we can populate directly, plus pseudo-targets combined/handled before building a row. */
type MappedField = keyof ImportedProspectRow | "firstName" | "lastName" | "ignore";

const HEADER_ALIASES: Record<string, MappedField> = {
  name: "fullName",
  fullname: "fullName",
  full_name: "fullName",
  "full name": "fullName",
  contact: "fullName",
  contactname: "fullName",
  "contact name": "fullName",
  "first name": "firstName",
  firstname: "firstName",
  first_name: "firstName",
  "last name": "lastName",
  lastname: "lastName",
  last_name: "lastName",
  surname: "lastName",
  email: "email",
  "e-mail": "email",
  "email address": "email",
  domain: "companyDomain",
  companydomain: "companyDomain",
  company_domain: "companyDomain",
  "company domain": "companyDomain",
  website: "companyDomain",
  company: "companyName",
  companyname: "companyName",
  company_name: "companyName",
  "company name": "companyName",
  account: "companyName",
  "account name": "companyName",
  title: "jobTitle",
  jobtitle: "jobTitle",
  job_title: "jobTitle",
  "job title": "jobTitle",
  role: "jobTitle",
  phone: "phone",
  mobile: "phone",
  "direct phone": "phone",
  "direct dial": "phone",
  linkedin: "linkedinUrl",
  linkedinurl: "linkedinUrl",
  linkedin_url: "linkedinUrl",
  "linkedin url": "linkedinUrl",
  "linkedin profile": "linkedinUrl",
  // "LinkedIn Location" is a free-text region, not a URL — must NOT fall into the generic
  // "includes linkedin" fallback below, or it silently clobbers the real linkedinUrl value.
  "linkedin location": "ignore",
  country: "country",
  "country/region": "country",
  "country / region": "country",
  region: "country",
  city: "city",
  location: "city",
  "zoominfo revenue": "companyRevenue",
  revenue: "companyRevenue",
  "annual revenue": "companyRevenue",
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Map a raw column header to a target field. `overrides` (from a user-supplied column-mapping
 * step) take priority over both the alias table and the heuristic fallbacks below, keyed by
 * either the original header text or its normalized form.
 */
function mapHeader(h: string, overrides?: Record<string, string>): MappedField | null {
  const key = normalizeHeader(h);
  if (overrides) {
    const override = overrides[h] ?? overrides[key];
    if (override) return override as MappedField;
  }
  if (HEADER_ALIASES[key]) return HEADER_ALIASES[key];
  if (key.includes("email")) return "email";
  if (key.includes("domain") || key.includes("website")) return "companyDomain";
  if (key.includes("linkedin")) return "linkedinUrl";
  if (key.includes("first")) return "firstName";
  if (key.includes("last")) return "lastName";
  if ((key.includes("name") || key === "contact") && !key.includes("company")) return "fullName";
  if (key.includes("company") && key.includes("name")) return "companyName";
  if (key.includes("title") || key.includes("role")) return "jobTitle";
  if (key.includes("phone") || key.includes("mobile")) return "phone";
  if (key.includes("country")) return "country";
  if (key.includes("revenue")) return "companyRevenue";
  return null;
}

function domainFromEmail(email?: string): string | undefined {
  if (!email?.includes("@")) return undefined;
  return email.split("@")[1]?.trim().toLowerCase();
}

/**
 * Turn a row's [header, value] pairs into a field->value dict, resolving each header through
 * `mapHeader` and combining separate First/Last Name columns into `fullName` when there's no
 * single combined name column.
 */
function buildRawRow(entries: [string, unknown][], overrides?: Record<string, string>): Record<string, string> {
  const raw: Record<string, string> = {};
  let firstName = "";
  let lastName = "";
  for (const [k, v] of entries) {
    const field = mapHeader(String(k), overrides);
    if (!field || field === "ignore") continue;
    const val = String(v ?? "").trim();
    if (!val) continue;
    if (field === "firstName") {
      firstName = val;
      continue;
    }
    if (field === "lastName") {
      lastName = val;
      continue;
    }
    raw[field] = val;
  }
  if (!raw.fullName && (firstName || lastName)) {
    raw.fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  }
  return raw;
}

function coerceRow(raw: Record<string, string>): ImportedProspectRow | null {
  const fullName = (raw.fullName ?? "").trim();
  let companyDomain = (raw.companyDomain ?? "").trim();
  const email = (raw.email ?? "").trim() || undefined;
  if (!companyDomain) {
    const fromEmail = domainFromEmail(email);
    if (fromEmail) companyDomain = fromEmail;
  }
  if (!fullName || !companyDomain) return null;
  companyDomain = normalizeDomain(companyDomain);
  if (!companyDomain) return null;
  return {
    fullName,
    companyDomain,
    email,
    jobTitle: raw.jobTitle?.trim() || undefined,
    companyName: raw.companyName?.trim() || undefined,
    phone: raw.phone?.trim() || undefined,
    linkedinUrl: raw.linkedinUrl?.trim() || undefined,
    country: raw.country?.trim() || undefined,
    city: raw.city?.trim() || undefined,
    companyRevenue: raw.companyRevenue?.trim() || undefined,
    raw,
  };
}

function parseDelimited(text: string, overrides?: Record<string, string>): ParseImportResult {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return { rows: [], source: "csv", warnings: ["File has no data rows"] };
  }

  const split = (line: string) => {
    const cols: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if ((ch === "," || ch === "\t" || ch === ";") && !inQuotes) {
        cols.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  };

  const headers = split(lines[0]!);
  const mappedHeaders: Record<string, string> = {};
  headers.forEach((h) => {
    mappedHeaders[h] = mapHeader(h, overrides) ?? "unmapped";
  });

  const rows: ImportedProspectRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = split(line);
    const entries: [string, unknown][] = headers.map((h, i) => [h, cols[i] ?? ""]);
    const raw = buildRawRow(entries, overrides);
    const row = coerceRow(raw);
    if (row) rows.push(row);
  }

  const warnings: string[] = [];
  if (!rows.length) {
    warnings.push(
      `No valid prospect rows found. Detected columns: ${
        headers.join(", ") || "none"
      }. Need a name column (or separate First Name / Last Name columns) plus an email or company domain — use column mapping if your headers use different names.`
    );
  }

  return {
    rows,
    source: "csv",
    warnings,
    sheets: [
      {
        headers,
        mappedHeaders,
        rowCount: rows.length,
        kind: rows.length ? "contacts" : "unknown",
      },
    ],
  };
}

interface SheetParseResult {
  sheetName: string;
  headers: string[];
  mappedHeaders: Record<string, string>;
  rows: ImportedProspectRow[];
  /** Rows that had a company name but no name/email — candidates for backfilling contact rows from other sheets. */
  accountRows: Record<string, string>[];
}

function sheetToRows(
  sheet: XLSX.WorkSheet,
  sheetName: string,
  overrides?: Record<string, string>
): SheetParseResult {
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const headerRow = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })[0] as unknown[] | undefined;
  const headers = json.length
    ? Object.keys(json[0]!)
    : (headerRow ?? []).map((h) => String(h ?? "").trim()).filter(Boolean);

  const mappedHeaders: Record<string, string> = {};
  for (const h of headers) {
    mappedHeaders[h] = mapHeader(h, overrides) ?? "unmapped";
  }

  const rows: ImportedProspectRow[] = [];
  const accountRows: Record<string, string>[] = [];
  for (const obj of json) {
    const raw = buildRawRow(Object.entries(obj), overrides);
    const row = coerceRow(raw);
    if (row) {
      rows.push(row);
    } else if (raw.companyName) {
      accountRows.push(raw);
    }
  }

  return { sheetName, headers, mappedHeaders, rows, accountRows };
}

function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Combine every sheet's rows (an XLSX with multiple tabs is no longer silently truncated to the
 * first one), and backfill contact rows with company-level fields (e.g. revenue) from any sheet
 * that looks like an accounts/company list — matched by normalized company name.
 */
function mergeSheetResults(results: SheetParseResult[]): ParseImportResult {
  const accountLookup = new Map<string, Record<string, string>>();
  for (const r of results) {
    for (const acc of r.accountRows) {
      if (!acc.companyName) continue;
      accountLookup.set(normalizeCompanyKey(acc.companyName), acc);
    }
  }

  const rows: ImportedProspectRow[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const row of r.rows) {
      if (row.companyName) {
        const acc = accountLookup.get(normalizeCompanyKey(row.companyName));
        if (acc) {
          if (!row.country && acc.country) row.country = acc.country;
          if (!row.phone && acc.phone) row.phone = acc.phone;
          if (!row.companyRevenue && acc.companyRevenue) row.companyRevenue = acc.companyRevenue;
        }
      }
      const dedupeKey = `${row.companyDomain}:${(row.email ?? row.fullName).toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push(row);
    }
  }

  const sheets: DetectedSheet[] = results.map((r) => ({
    sheetName: r.sheetName,
    headers: r.headers,
    mappedHeaders: r.mappedHeaders,
    rowCount: r.rows.length,
    kind: r.rows.length > 0 ? "contacts" : r.accountRows.length > 0 ? "accounts" : "unknown",
  }));

  const warnings: string[] = [];
  if (!rows.length) {
    const summary = sheets
      .map((s) => `"${s.sheetName}" (${s.headers.join(", ") || "no headers detected"})`)
      .join("; ");
    warnings.push(
      `No valid prospect rows found. Need a name column (or separate First Name / Last Name columns) plus an email or company domain, on at least one sheet. Detected: ${
        summary || "no sheets"
      }. Use column mapping if your headers use different names.`
    );
  } else {
    const accountsUsed = sheets.filter((s) => s.kind === "accounts");
    if (accountsUsed.length) {
      warnings.push(
        `Company-level columns from ${accountsUsed
          .map((s) => `"${s.sheetName}"`)
          .join(", ")} (e.g. revenue) were matched onto contacts by company name for preview only — they are not stored on commit.`
      );
    }
  }

  return { rows, source: "xlsx", warnings, sheets };
}

const OCR_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

function normalizeOcrMime(mimeType: string, filename: string): string | null {
  const mime = mimeType.toLowerCase();
  if (OCR_IMAGE_MIMES.has(mime)) return mime === "image/jpg" ? "image/jpeg" : mime;
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.webp$/i.test(filename)) return "image/webp";
  if (/\.gif$/i.test(filename)) return "image/gif";
  return null;
}

function ocrErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/provider returned error|invalid_request|unsupported|400/i.test(msg)) {
    return "OCR provider rejected this file — use PNG, JPEG, WebP, or GIF (SVG is parsed as text, not OCR)";
  }
  return msg || "OCR failed";
}

async function ocrWithOpenRouter(
  buffer: Buffer,
  mimeType: string,
  apiKey: string | undefined,
  hint: string
): Promise<ParseImportResult> {
  if (!apiKey) {
    return {
      rows: [],
      source: "ocr",
      warnings: ["OpenRouter API key required for OCR of PDF/images"],
    };
  }

  if (mimeType === "image/svg+xml" || mimeType.includes("svg")) {
    return parseSvg(buffer);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI Import" },
  });

  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const prompt = `Extract prospect/contact rows from this ${hint}. Return JSON only:
{"rows":[{"fullName":"","companyDomain":"","email":"","jobTitle":"","companyName":"","phone":"","linkedinUrl":"","country":"","city":""}]}
Rules: companyDomain is required (derive from email domain if needed). Skip incomplete rows. Max 200 rows.`;

  try {
    const result = await client.chat.completions.create({
      model: process.env.AI_OCR_MODEL ?? "openai/gpt-4o-mini",
      max_tokens: 4000,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const raw = result.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { rows?: Record<string, string>[] };
    const rows: ImportedProspectRow[] = [];
    for (const r of parsed.rows ?? []) {
      const row = coerceRow({
        fullName: r.fullName ?? "",
        companyDomain: r.companyDomain ?? "",
        email: r.email ?? "",
        jobTitle: r.jobTitle ?? "",
        companyName: r.companyName ?? "",
        phone: r.phone ?? "",
        linkedinUrl: r.linkedinUrl ?? "",
        country: r.country ?? "",
        city: r.city ?? "",
      });
      if (row) rows.push(row);
    }
    return {
      rows,
      source: "ocr",
      warnings: rows.length ? [] : ["OCR completed but no valid prospects were found"],
    };
  } catch (err) {
    log.error("OCR import failed", { err });
    return {
      rows: [],
      source: "ocr",
      warnings: [ocrErrorMessage(err)],
    };
  }
}

export async function parseImportFile(input: {
  filename: string;
  mimeType: string;
  base64: string;
  openRouterApiKey?: string;
  /** Optional manual column mapping (source header -> target field), from a mapping-correction UI. */
  headerMap?: Record<string, string>;
}): Promise<ParseImportResult> {
  const buffer = Buffer.from(input.base64, "base64");
  const name = input.filename.toLowerCase();
  const mime = (input.mimeType || "").toLowerCase();

  if (name.endsWith(".csv") || mime.includes("csv") || mime === "text/plain") {
    return parseDelimited(buffer.toString("utf8"), input.headerMap);
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls") || mime.includes("spreadsheet") || mime.includes("excel")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    if (!wb.SheetNames.length) return { rows: [], source: "xlsx", warnings: ["Empty workbook"] };
    // Read every sheet — a workbook split into e.g. "Accounts" + "Contacts" tabs used to have
    // everything but the first sheet silently dropped.
    const sheetResults = wb.SheetNames.map((sheetName) =>
      sheetToRows(wb.Sheets[sheetName]!, sheetName, input.headerMap)
    );
    return mergeSheetResults(sheetResults);
  }

  if (name.endsWith(".pdf") || mime === "application/pdf") {
    try {
      const text = await extractPdfText(buffer);
      if (text.length > 40) {
        const looksTabular = /email|name|company/i.test(text) && text.includes("\n");
        if (looksTabular) {
          const asCsv = parseDelimited(text, input.headerMap);
          if (asCsv.rows.length) return { ...asCsv, source: "pdf", warnings: asCsv.warnings };
        }
      }
    } catch (err) {
      log.warn("pdf text extract failed; trying OCR", { err });
    }
    return ocrPdfTextOrImage(buffer, input.openRouterApiKey);
  }

  // SVG is XML text — vision OCR rejects image/svg+xml with "400 Provider returned error".
  if (name.endsWith(".svg") || mime === "image/svg+xml" || mime.includes("svg+xml")) {
    return parseSvg(buffer);
  }

  const ocrMime = normalizeOcrMime(mime, name);
  if (ocrMime || mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name)) {
    if (!ocrMime) {
      return {
        rows: [],
        source: "image",
        warnings: [
          `Unsupported image type "${mime || name}" for OCR. Use PNG, JPEG, WebP, or GIF. SVG is parsed as text automatically.`,
        ],
      };
    }
    return ocrWithOpenRouter(
      buffer,
      ocrMime,
      input.openRouterApiKey,
      "image (contact list / business card)"
    );
  }

  // Last resort: treat as UTF-8 CSV
  return parseDelimited(buffer.toString("utf8"), input.headerMap);
}

async function ocrPdfTextOrImage(
  buffer: Buffer,
  apiKey: string | undefined
): Promise<ParseImportResult> {
  if (!apiKey) {
    return { rows: [], source: "pdf", warnings: ["Could not parse PDF; OpenRouter key needed for OCR"] };
  }

  let pdfText = "";
  try {
    pdfText = (await extractPdfText(buffer)).slice(0, 12000);
  } catch {
    /* ignore */
  }

  if (!pdfText.trim()) {
    // Some PDFs are image-only; OpenRouter may still accept application/pdf as file in some models —
    // fall back to treating as generic OCR with data URL (limited support).
    return ocrWithOpenRouter(buffer, "application/pdf", apiKey, "PDF document");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI Import" },
  });

  try {
    const result = await client.chat.completions.create({
      model: process.env.AI_OCR_MODEL ?? "openai/gpt-4o-mini",
      max_tokens: 4000,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: `Extract prospect rows from this PDF text. Return JSON:
{"rows":[{"fullName":"","companyDomain":"","email":"","jobTitle":"","companyName":"","phone":"","linkedinUrl":"","country":"","city":""}]}
Derive companyDomain from email when missing. Max 200 rows.

PDF text:
${pdfText}`,
        },
      ],
    });
    const raw = result.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { rows?: Record<string, string>[] };
    const rows: ImportedProspectRow[] = [];
    for (const r of parsed.rows ?? []) {
      const row = coerceRow({
        fullName: r.fullName ?? "",
        companyDomain: r.companyDomain ?? "",
        email: r.email ?? "",
        jobTitle: r.jobTitle ?? "",
        companyName: r.companyName ?? "",
        phone: r.phone ?? "",
        linkedinUrl: r.linkedinUrl ?? "",
        country: r.country ?? "",
        city: r.city ?? "",
      });
      if (row) rows.push(row);
    }
    return {
      rows,
      source: "pdf",
      warnings: rows.length ? [] : ["PDF OCR found no valid prospects"],
    };
  } catch (err) {
    return {
      rows: [],
      source: "pdf",
      warnings: [err instanceof Error ? err.message : "PDF OCR failed"],
    };
  }
}

export async function commitImport(opts: {
  db: Db;
  config: Env;
  workspaceId: string;
  rows: ImportedProspectRow[];
  listId?: string;
  listName?: string;
  autoEnrich?: boolean;
}): Promise<{
  imported: number;
  listId: string | null;
  listName: string | null;
  prospectIds: string[];
  skipped: number;
}> {
  const { db, config, workspaceId, rows } = opts;
  const osCfg: OpenSearchConfig | null = config.OPENSEARCH_URL
    ? {
        url: config.OPENSEARCH_URL,
        username: config.OPENSEARCH_USERNAME,
        password: config.OPENSEARCH_PASSWORD,
        index: config.OPENSEARCH_INDEX,
      }
    : null;

  const enrichment = buildEnrichmentService(db, config);
  const listSvc = buildListService(db, osCfg);

  let listId = opts.listId ?? null;
  let listName: string | null = null;
  if (!listId && opts.listName?.trim() && listSvc) {
    const list = await listSvc.createList(workspaceId, opts.listName.trim());
    listId = list.id;
    listName = list.name;
  } else if (listId && listSvc) {
    const list = await listSvc.getListById(workspaceId, listId);
    if (!list) throw Object.assign(new Error("list_not_found"), { statusCode: 404 });
    listName = list.name;
  }

  const prospectIds: string[] = [];
  let skipped = 0;
  const osDocs: ProspectDocument[] = [];
  const snapshots: Array<{
    prospectId: string;
    companyId: string;
    fullName: string;
    title?: string;
    companyDomain: string;
    companyName?: string;
    email?: string;
    phone?: string;
    linkedinUrl?: string;
    country?: string;
    city?: string;
  }> = [];

  for (const row of rows.slice(0, 500)) {
    const domain = normalizeDomain(row.companyDomain);
    const companyId = generateCompanyId(domain);
    const prospectId = row.email
      ? generateProspectId(domain, row.email)
      : generateCompanyId(`${domain}:${row.fullName}`);

    prospectIds.push(prospectId);
    snapshots.push({
      prospectId,
      companyId,
      fullName: row.fullName,
      title: row.jobTitle,
      companyDomain: domain,
      companyName: row.companyName,
      email: row.email,
      phone: row.phone,
      linkedinUrl: row.linkedinUrl,
      country: row.country,
      city: row.city,
    });

    if (osCfg) {
      osDocs.push({
        prospectId,
        companyId,
        fullName: row.fullName,
        title: row.jobTitle,
        email: row.email,
        phone: row.phone,
        linkedinUrl: row.linkedinUrl,
        companyDomain: domain,
        companyName: row.companyName,
        country: row.country,
        city: row.city,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (!snapshots.length) {
    return { imported: 0, listId, listName, prospectIds: [], skipped: rows.length };
  }

  if (osCfg && osDocs.length) {
    await bulkUpsertProspects(osCfg, osDocs);
  }

  await enrichment.activate(workspaceId, snapshots);

  if (listId) {
    const added = await enrichment.addListMembers(workspaceId, listId, snapshots);
    if (!added) throw Object.assign(new Error("list_not_found"), { statusCode: 404 });
  }

  if (opts.autoEnrich) {
    for (const snap of snapshots.slice(0, 50)) {
      try {
        await enrichment.enrichProspect(workspaceId, snap, {
          fields: ["company", "email", "validation"],
          trigger: "manual",
        });
      } catch {
        skipped += 1;
      }
    }
  }

  return {
    imported: snapshots.length,
    listId,
    listName,
    prospectIds,
    skipped,
  };
}
