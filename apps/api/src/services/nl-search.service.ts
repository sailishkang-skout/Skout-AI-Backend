import {
  COMPANY_SIGNALS,
  COMPANY_STAGES,
  CONTACT_SIGNALS,
  DEPARTMENTS,
  SENIORITY_OPTIONS,
  type SearchFiltersInput,
} from "@skout/shared";
import { createLogger } from "@skout/observability";

const log = createLogger("nl-search.service");

const SENIORITY_VALUES = new Set(SENIORITY_OPTIONS.map((o) => o.value));
const DEPARTMENT_VALUES = new Set<string>(DEPARTMENTS);
const CONTACT_SIGNAL_VALUES = new Set(CONTACT_SIGNALS.map((s) => s.value));
const COMPANY_SIGNAL_VALUES = new Set(COMPANY_SIGNALS.map((s) => s.value));
const COMPANY_STAGE_VALUES = new Set(COMPANY_STAGES.map((s) => s.value));

/** Fields this translator is allowed to fill — a deliberate subset of SearchFilters that
 * natural language reliably expresses; fields like fullName/companyDomain are left to the
 * structured filter UI, not guessed from free text. */
export type NlTranslatableFilters = Pick<
  SearchFiltersInput,
  | "jobTitle"
  | "seniority"
  | "department"
  | "country"
  | "state"
  | "city"
  | "industry"
  | "minEmployees"
  | "maxEmployees"
  | "currentlyHiring"
  | "contactSignals"
  | "companySignals"
  | "companyStage"
>;

export interface NlTranslationResult {
  filters: NlTranslatableFilters;
  /** Which path produced these filters — surfaced to the caller/UI so an LLM guess and a
   * keyword-matched guess aren't presented with the same confidence. */
  method: "llm" | "heuristic";
  /** §6.1 — LLM-inferred filters are suggestions, not verified facts. */
  unverified: boolean;
}

const COUNTRY_ALIASES: Record<string, string> = {
  us: "United States", usa: "United States", "united states": "United States", america: "United States",
  uk: "United Kingdom", "united kingdom": "United Kingdom", britain: "United Kingdom",
  germany: "Germany", france: "France", canada: "Canada", australia: "Australia",
  india: "India", spain: "Spain", italy: "Italy", netherlands: "Netherlands",
  brazil: "Brazil", mexico: "Mexico", japan: "Japan", singapore: "Singapore",
};

/** Common industry names worth matching by keyword — not exhaustive, just the frequently-searched ones. */
const INDUSTRY_KEYWORDS = [
  "SaaS", "Fintech", "Healthcare", "E-commerce", "Biotech", "Manufacturing",
  "Insurance", "Real Estate", "Logistics", "Retail", "Education", "Cybersecurity",
  "Marketing", "Legal", "Hospitality", "Telecom", "Media", "Gaming",
];

function heuristicTranslate(query: string): NlTranslatableFilters {
  const q = query.toLowerCase();
  const filters: NlTranslatableFilters = {};

  for (const { value } of SENIORITY_OPTIONS) {
    const spaced = value.replace(/_/g, " ");
    if (q.includes(spaced) || q.includes(value)) {
      filters.seniority = value;
      break;
    }
  }
  if (!filters.seniority && /\bc-level\b|\bc level\b|\bexec(utive)?\b/.test(q)) filters.seniority = "c_level";
  if (!filters.seniority && /\bhead of\b/.test(q)) filters.seniority = "head";
  if (!filters.seniority && /\bic\b|\bindividual contributor\b/.test(q)) filters.seniority = "individual_contributor";

  for (const dept of DEPARTMENT_VALUES) {
    if (q.includes(dept.toLowerCase())) {
      filters.department = dept;
      break;
    }
  }

  const employeeMatch = q.match(/(\d[\d,]*)\+?\s*(?:to\s*(\d[\d,]*))?\s*employees/);
  if (employeeMatch) {
    const min = Number(employeeMatch[1].replace(/,/g, ""));
    if (Number.isFinite(min)) filters.minEmployees = min;
    if (employeeMatch[2]) {
      const max = Number(employeeMatch[2].replace(/,/g, ""));
      if (Number.isFinite(max)) filters.maxEmployees = max;
    }
  }

  if (/\bhiring\b|\bgrowing (their|the)?\s*team\b|\bexpanding (their|the)?\s*team\b/.test(q)) {
    filters.currentlyHiring = true;
  }

  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(q)) {
      filters.country = country;
      break;
    }
  }

  for (const industry of INDUSTRY_KEYWORDS) {
    if (q.includes(industry.toLowerCase())) {
      filters.industry = industry;
      break;
    }
  }

  const contactSignals: string[] = [];
  for (const { value, label } of CONTACT_SIGNALS) {
    if (q.includes(label.toLowerCase()) || q.includes(value.replace(/_/g, " "))) contactSignals.push(value);
  }
  if (contactSignals.length > 0) filters.contactSignals = contactSignals;

  const companySignals: string[] = [];
  if (/\brecent(ly)? (raised|funded|funding)\b|\bjust raised\b/.test(q)) companySignals.push("recent_funding");
  if (/\bnew ceo\b|\bleadership change\b|\bnew leadership\b/.test(q)) companySignals.push("leadership_change");
  if (/\bnew product\b|\bproduct launch\b/.test(q)) companySignals.push("new_product_launch");
  if (/\bexpanding into\b|\bnew market\b/.test(q)) companySignals.push("expansion_new_markets");
  if (companySignals.length > 0) filters.companySignals = companySignals.filter((s) => COMPANY_SIGNAL_VALUES.has(s as never));

  for (const { value } of COMPANY_STAGES) {
    const spaced = value.replace(/_/g, " ");
    if (q.includes(spaced)) {
      filters.companyStage = value;
      break;
    }
  }

  return filters;
}

function sanitizeLlmFilters(raw: Record<string, unknown>): NlTranslatableFilters {
  const filters: NlTranslatableFilters = {};
  if (typeof raw.jobTitle === "string" && raw.jobTitle.trim()) filters.jobTitle = raw.jobTitle.trim();
  if (typeof raw.seniority === "string" && SENIORITY_VALUES.has(raw.seniority as never)) {
    filters.seniority = raw.seniority as SearchFiltersInput["seniority"];
  }
  if (typeof raw.department === "string" && DEPARTMENT_VALUES.has(raw.department)) {
    filters.department = raw.department;
  }
  if (typeof raw.country === "string" && raw.country.trim()) filters.country = raw.country.trim();
  if (typeof raw.state === "string" && raw.state.trim()) filters.state = raw.state.trim();
  if (typeof raw.city === "string" && raw.city.trim()) filters.city = raw.city.trim();
  if (typeof raw.industry === "string" && raw.industry.trim()) filters.industry = raw.industry.trim();
  if (typeof raw.minEmployees === "number" && raw.minEmployees >= 0) filters.minEmployees = Math.round(raw.minEmployees);
  if (typeof raw.maxEmployees === "number" && raw.maxEmployees >= 0) filters.maxEmployees = Math.round(raw.maxEmployees);
  if (typeof raw.currentlyHiring === "boolean") filters.currentlyHiring = raw.currentlyHiring;
  if (Array.isArray(raw.contactSignals)) {
    const signals = raw.contactSignals.filter((s): s is string => typeof s === "string" && CONTACT_SIGNAL_VALUES.has(s as never));
    if (signals.length > 0) filters.contactSignals = signals;
  }
  if (Array.isArray(raw.companySignals)) {
    const signals = raw.companySignals.filter((s): s is string => typeof s === "string" && COMPANY_SIGNAL_VALUES.has(s as never));
    if (signals.length > 0) filters.companySignals = signals;
  }
  if (typeof raw.companyStage === "string" && COMPANY_STAGE_VALUES.has(raw.companyStage as never)) {
    filters.companyStage = raw.companyStage as SearchFiltersInput["companyStage"];
  }
  return filters;
}

function buildSystemPrompt(): string {
  return [
    "Extract structured search filters from a recruiter/sales query. Return ONLY a JSON object.",
    "Allowed keys: jobTitle (string), seniority (one of: " + [...SENIORITY_VALUES].join(", ") + "),",
    "department (one of: " + [...DEPARTMENT_VALUES].join(", ") + "), country, state, city, industry (strings),",
    "minEmployees, maxEmployees (numbers), currentlyHiring (boolean),",
    "contactSignals (array from: " + [...CONTACT_SIGNAL_VALUES].join(", ") + "),",
    "companySignals (array from: " + [...COMPANY_SIGNAL_VALUES].join(", ") + "),",
    "companyStage (one of: " + [...COMPANY_STAGE_VALUES].join(", ") + ").",
    "Omit any key you can't confidently infer. Never invent a value outside the allowed lists.",
  ].join(" ");
}

async function llmTranslate(query: string, apiKey: string, timeoutMs: number): Promise<NlTranslatableFilters> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: timeoutMs,
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });
  const model = process.env.AI_MODEL ?? "openai/gpt-4o-mini";

  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: query },
    ],
  });

  const raw = JSON.parse(res.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
  return sanitizeLlmFilters(raw);
}

/**
 * 8.2 Ask — "natural-language search and structured filters as one query model". Translates
 * free text into the SAME SearchFilters shape the structured-filter UI produces, so a caller
 * merges the result straight into an existing filter object rather than running a second,
 * separate search path. LLM path when OPENROUTER_API_KEY is configured; deterministic keyword
 * heuristic otherwise or on any LLM failure — mirrors the fallback shape already used by
 * enrichment/ai-client.ts's scoreProspect().
 */
export async function translateNaturalLanguageQuery(
  query: string,
  opts: { openrouterApiKey?: string; timeoutMs?: number } = {}
): Promise<NlTranslationResult> {
  const trimmed = query.trim();
  if (!trimmed) return { filters: {}, method: "heuristic", unverified: false };

  if (opts.openrouterApiKey) {
    try {
      const filters = await llmTranslate(trimmed, opts.openrouterApiKey, opts.timeoutMs ?? 5000);
      return { filters, method: "llm", unverified: true };
    } catch (err) {
      log.error("NL query LLM translation failed, falling back to heuristic", err);
    }
  }

  return { filters: heuristicTranslate(trimmed), method: "heuristic", unverified: false };
}

/** Merges translated filters into a caller's existing structured filters — explicit,
 * already-set values always win over an inferred guess from free text. */
export function mergeTranslatedFilters(
  existing: SearchFiltersInput,
  translated: NlTranslatableFilters
): SearchFiltersInput {
  const merged: SearchFiltersInput = { ...existing };
  for (const [key, value] of Object.entries(translated) as [keyof NlTranslatableFilters, unknown][]) {
    if (merged[key] === undefined && value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
