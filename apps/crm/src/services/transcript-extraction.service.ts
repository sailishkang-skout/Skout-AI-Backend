import { OpenAI } from "openai";
import type { Env } from "../config/env.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("transcript-extraction");

export interface ExtractedContactFields {
  title?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
}

export interface ExtractedCompanyFields {
  industry?: string;
  employeeCount?: number;
  revenue?: number;
  location?: string;
}

/** budget → amount, timeline → closeDate (R16.3 AC). */
export interface ExtractedDealFields {
  amount?: number;
  closeDate?: string;
}

export interface TranscriptExtractionResult {
  contact?: ExtractedContactFields;
  contactConfidence?: number;
  company?: ExtractedCompanyFields;
  companyConfidence?: number;
  deal?: ExtractedDealFields;
  dealConfidence?: number;
  /** Free text — not a scalar CRM field, so this isn't auto-filled; posted to the activity timeline instead. */
  nextSteps?: string;
  /** People mentioned as involved in the buying decision — same reasoning as nextSteps. */
  stakeholders?: string[];
}

export function isTranscriptExtractionConfigured(config: Env): boolean {
  return Boolean(config.OPENROUTER_API_KEY);
}

const SYSTEM_PROMPT = `You extract structured CRM data from a sales-call transcript. Read the
transcript and output ONLY valid JSON (no markdown fences, no commentary) matching exactly this
shape:
{
  "contact": { "title"?: string, "email"?: string, "phone"?: string, "linkedinUrl"?: string },
  "contactConfidence": number between 0 and 1,
  "company": { "industry"?: string, "employeeCount"?: number, "revenue"?: number, "location"?: string },
  "companyConfidence": number between 0 and 1,
  "deal": { "amount"?: number, "closeDate"?: "YYYY-MM-DD" },
  "dealConfidence": number between 0 and 1,
  "nextSteps": "one short paragraph summarizing agreed next steps",
  "stakeholders": ["Name — role", "..."]
}
Only include a field/object if the transcript actually states it — never guess or invent values.
Omit "contact" / "company" / "deal" (and their *Confidence) entirely if nothing relevant was
said for that group. "amount" is a plain number in the deal's currency (no symbols, no commas).
"closeDate" must be a real calendar date the transcript implies (e.g. "end of Q2" → your
best-guess ISO date) — omit if you can't infer a specific date. Omit "nextSteps" or
"stakeholders" if the transcript doesn't clearly support them.`;

/**
 * R16.3 — calls an LLM (via OpenRouter, matching apps/api's next-best-action.service.ts pattern)
 * on the raw transcript text to produce typed fields, used when the meeting-bot vendor doesn't
 * supply its own structured `extractedFields` in the webhook payload. Returns `{}` (never
 * throws) when unconfigured or on any LLM/parse failure — this runs inside a public webhook
 * handler and must never turn a transcript-delivery failure into a 500.
 */
export async function extractFieldsFromTranscript(config: Env, transcript: string): Promise<TranscriptExtractionResult> {
  if (!isTranscriptExtractionConfigured(config) || !transcript.trim()) return {};

  const client = new OpenAI({
    apiKey: config.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });

  let raw: string;
  try {
    const result = await client.chat.completions.create({
      model: config.AI_MODEL,
      max_tokens: 700,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        // Transcripts can run long; cap to keep this affordable — comfortably covers a 30-60 min call.
        { role: "user", content: transcript.slice(0, 24000) },
      ],
    });
    raw = result.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    log.warn("transcript extraction LLM call failed", { err });
    return {};
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("transcript extraction returned unparseable JSON");
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
  const dealRaw = (parsed.deal ?? {}) as Record<string, unknown>;

  const stakeholdersRaw = Array.isArray(parsed.stakeholders) ? parsed.stakeholders : [];
  const stakeholders = stakeholdersRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  return {
    contact: nonEmpty<ExtractedContactFields>({
      title: str(contactRaw.title),
      email: str(contactRaw.email),
      phone: str(contactRaw.phone),
      linkedinUrl: str(contactRaw.linkedinUrl),
    }),
    contactConfidence: clamp01(parsed.contactConfidence),
    company: nonEmpty<ExtractedCompanyFields>({
      industry: str(companyRaw.industry),
      employeeCount: num(companyRaw.employeeCount),
      revenue: num(companyRaw.revenue),
      location: str(companyRaw.location),
    }),
    companyConfidence: clamp01(parsed.companyConfidence),
    deal: nonEmpty<ExtractedDealFields>({ amount: num(dealRaw.amount), closeDate: str(dealRaw.closeDate) }),
    dealConfidence: clamp01(parsed.dealConfidence),
    nextSteps: str(parsed.nextSteps),
    stakeholders: stakeholders.length > 0 ? stakeholders : undefined,
  };
}
