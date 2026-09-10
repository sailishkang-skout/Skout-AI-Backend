import { OpenAI } from "openai";
import type { Env } from "../config/env.js";
import { createLogger } from "@skout/observability";

const log = createLogger("call-notes-extraction");

/**
 * R13.3 — the call_note counterpart to apps/crm's transcript-extraction.service.ts (R16.3). A
 * separate module (not a cross-service import — apps/api and apps/crm are separately deployed)
 * but deliberately mirrors its shape: same typed-fields-with-confidence contract, same
 * never-throw behavior, so callers can treat both extraction sources identically.
 */
export interface ExtractedCallContactFields {
  title?: string;
  email?: string;
  phone?: string;
}

export interface ExtractedCallCompanyFields {
  industry?: string;
  employeeCount?: number;
  location?: string;
}

export interface CallNotesExtractionResult {
  contact?: ExtractedCallContactFields;
  contactConfidence?: number;
  company?: ExtractedCallCompanyFields;
  companyConfidence?: number;
}

export function isCallNotesExtractionConfigured(config: Env): boolean {
  return Boolean(config.OPENROUTER_API_KEY);
}

const SYSTEM_PROMPT = `You extract structured CRM data from a sales rep's free-text notes about a
phone call. Read the notes and output ONLY valid JSON (no markdown fences, no commentary)
matching exactly this shape:
{
  "contact": { "title"?: string, "email"?: string, "phone"?: string },
  "contactConfidence": number between 0 and 1,
  "company": { "industry"?: string, "employeeCount"?: number, "location"?: string },
  "companyConfidence": number between 0 and 1
}
Only include a field/object if the notes actually state it — never guess or invent values. Omit
"contact" or "company" (and their *Confidence) entirely if nothing relevant was said.`;

/**
 * Runs an LLM extraction pass over one call's notes text. Returns `{}` (never throws) when
 * unconfigured, given empty notes, or on any LLM/parse failure — this is a best-effort side
 * effect of saving call notes and must never fail that save.
 */
export async function extractFieldsFromCallNotes(config: Env, notes: string): Promise<CallNotesExtractionResult> {
  if (!isCallNotesExtractionConfigured(config) || !notes.trim()) return {};

  const client = new OpenAI({
    apiKey: config.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });

  let raw: string;
  try {
    const result = await client.chat.completions.create({
      model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
      max_tokens: 400,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: notes.slice(0, 8000) },
      ],
    });
    raw = result.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    log.warn("call-notes extraction LLM call failed", { err });
    return {};
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("call-notes extraction returned unparseable JSON");
    return {};
  }

  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const clamp01 = (v: unknown): number | undefined => {
    const n = num(v);
    return n === undefined ? undefined : Math.max(0, Math.min(1, n));
  };
  const nonEmpty = <T extends object>(obj: T): T | undefined =>
    Object.values(obj).some((v) => v !== undefined) ? obj : undefined;

  const contactRaw = (parsed.contact ?? {}) as Record<string, unknown>;
  const companyRaw = (parsed.company ?? {}) as Record<string, unknown>;

  return {
    contact: nonEmpty<ExtractedCallContactFields>({
      title: str(contactRaw.title),
      email: str(contactRaw.email),
      phone: str(contactRaw.phone),
    }),
    contactConfidence: clamp01(parsed.contactConfidence),
    company: nonEmpty<ExtractedCallCompanyFields>({
      industry: str(companyRaw.industry),
      employeeCount: num(companyRaw.employeeCount),
      location: str(companyRaw.location),
    }),
    companyConfidence: clamp01(parsed.companyConfidence),
  };
}
