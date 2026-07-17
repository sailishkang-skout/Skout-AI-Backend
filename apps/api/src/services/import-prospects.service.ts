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
  raw?: Record<string, string>;
}

export interface ParseImportResult {
  rows: ImportedProspectRow[];
  source: "csv" | "xlsx" | "pdf" | "image" | "ocr" | "svg";
  warnings: string[];
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

const HEADER_ALIASES: Record<string, keyof ImportedProspectRow | "ignore"> = {
  name: "fullName",
  fullname: "fullName",
  full_name: "fullName",
  "full name": "fullName",
  contact: "fullName",
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
  title: "jobTitle",
  jobtitle: "jobTitle",
  job_title: "jobTitle",
  "job title": "jobTitle",
  role: "jobTitle",
  phone: "phone",
  mobile: "phone",
  linkedin: "linkedinUrl",
  linkedinurl: "linkedinUrl",
  linkedin_url: "linkedinUrl",
  "linkedin url": "linkedinUrl",
  country: "country",
  city: "city",
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function mapHeader(h: string): keyof ImportedProspectRow | "ignore" | null {
  const key = normalizeHeader(h);
  if (HEADER_ALIASES[key]) return HEADER_ALIASES[key];
  if (key.includes("email")) return "email";
  if (key.includes("domain") || key.includes("website")) return "companyDomain";
  if (key.includes("linkedin")) return "linkedinUrl";
  if ((key.includes("name") || key === "contact") && !key.includes("company")) return "fullName";
  if (key.includes("company") && key.includes("name")) return "companyName";
  if (key.includes("title") || key.includes("role")) return "jobTitle";
  if (key.includes("phone") || key.includes("mobile")) return "phone";
  return null;
}

function domainFromEmail(email?: string): string | undefined {
  if (!email?.includes("@")) return undefined;
  return email.split("@")[1]?.trim().toLowerCase();
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
    raw,
  };
}

function parseDelimited(text: string): ParseImportResult {
  const warnings: string[] = [];
  const lines = text
    .replace(/^\uFEFF/, "")
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
  const mapping = headers.map(mapHeader);
  if (!mapping.some((m) => m === "fullName") && !mapping.some((m) => m === "email")) {
    warnings.push("Could not detect name/email columns — check header row");
  }

  const rows: ImportedProspectRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = split(line);
    const raw: Record<string, string> = {};
    mapping.forEach((field, i) => {
      if (!field || field === "ignore") return;
      const val = cols[i] ?? "";
      if (val) raw[field] = val;
    });
    const row = coerceRow(raw);
    if (row) rows.push(row);
  }

  return { rows, source: "csv", warnings };
}

function sheetToRows(sheet: XLSX.WorkSheet): ParseImportResult {
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const warnings: string[] = [];
  const rows: ImportedProspectRow[] = [];
  for (const obj of json) {
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      const field = mapHeader(String(k));
      if (!field || field === "ignore") continue;
      const val = String(v ?? "").trim();
      if (val) raw[field] = val;
    }
    const row = coerceRow(raw);
    if (row) rows.push(row);
  }
  if (!rows.length) warnings.push("No valid prospect rows found in spreadsheet");
  return { rows, source: "xlsx", warnings };
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
}): Promise<ParseImportResult> {
  const buffer = Buffer.from(input.base64, "base64");
  const name = input.filename.toLowerCase();
  const mime = (input.mimeType || "").toLowerCase();

  if (name.endsWith(".csv") || mime.includes("csv") || mime === "text/plain") {
    return parseDelimited(buffer.toString("utf8"));
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls") || mime.includes("spreadsheet") || mime.includes("excel")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]!];
    if (!sheet) return { rows: [], source: "xlsx", warnings: ["Empty workbook"] };
    return sheetToRows(sheet);
  }

  if (name.endsWith(".pdf") || mime === "application/pdf") {
    try {
      const text = await extractPdfText(buffer);
      if (text.length > 40) {
        const looksTabular = /email|name|company/i.test(text) && text.includes("\n");
        if (looksTabular) {
          const asCsv = parseDelimited(text);
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
  return parseDelimited(buffer.toString("utf8"));
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
