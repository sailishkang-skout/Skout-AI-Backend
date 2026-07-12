export interface ScoreInput {
  prospectId: string;
  fullName?: string;
  title?: string;
  seniority?: string;
  industry?: string;
  country?: string;
  employeeCount?: number;
  companyDomain?: string;
  signals?: string[];
}

export interface IcpConfig {
  industries?: string[];
  countries?: string[];
  seniorities?: string[];
  titles?: string[];
  keywords?: string[];
  minEmployees?: number;
  maxEmployees?: number;
  /** When false, saving ICP does not enqueue a workspace-wide re-score. Default: true. */
  autoRescoreOnChange?: boolean;
}

export interface DimensionScore {
  score: number;
  matched: boolean;
  explanation: string;
}

export interface ScoreResult {
  prospectId: string;
  icpScore: number;
  icpBand: string;
  intentScore: number;
  painPoints: string[];
  outreachReadiness: string;
  reasoning: string;
  source: "llm" | "heuristic";
  creditsUsed?: number;
  dimensions: Record<string, DimensionScore>;
}

const BANDS = (s: number) => (s >= 75 ? "strong" : s >= 45 ? "medium" : "weak");
const READINESS = (icp: number, intent: number) =>
  icp >= 75 && intent >= 60 ? "ready" : icp >= 60 ? "warm" : icp >= 40 ? "nurture" : "not_qualified";

/** Local deterministic fallback mirroring apps/ai /v1/score (strategy §9). */
export function scoreLocally(input: ScoreInput, icp: IcpConfig = {}): ScoreResult {
  let score = 40;
  const dimensions: Record<string, DimensionScore> = {};

  if (icp.industries?.length && input.industry) {
    if (icp.industries.includes(input.industry)) {
      score += 20;
      dimensions.industry = { score: 80, matched: true, explanation: `${input.industry} is in target industries` };
    } else {
      score -= 10;
      dimensions.industry = { score: 20, matched: false, explanation: `${input.industry} not in target industries` };
    }
  } else {
    dimensions.industry = { score: 50, matched: true, explanation: "Industry not specified in ICP" };
  }

  if (icp.seniorities?.length && input.seniority) {
    if (icp.seniorities.includes(input.seniority)) {
      score += 15;
      dimensions.seniority = { score: 80, matched: true, explanation: `${input.seniority} matches target seniority` };
    } else {
      dimensions.seniority = { score: 30, matched: false, explanation: `${input.seniority} not in target seniorities` };
    }
  } else {
    dimensions.seniority = { score: 50, matched: true, explanation: "Seniority not specified in ICP" };
  }

  if (icp.countries?.length && input.country) {
    if (icp.countries.includes(input.country)) {
      score += 10;
      dimensions.geography = { score: 80, matched: true, explanation: `${input.country} is in target countries` };
    } else {
      score -= 5;
      dimensions.geography = { score: 20, matched: false, explanation: `${input.country} not in target countries` };
    }
  } else {
    dimensions.geography = { score: 50, matched: true, explanation: "Geography not specified in ICP" };
  }

  if (input.employeeCount != null) {
    const lo = icp.minEmployees ?? 0;
    const hi = icp.maxEmployees ?? Number.MAX_SAFE_INTEGER;
    if (input.employeeCount >= lo && input.employeeCount <= hi) {
      score += 10;
      dimensions.company_size = { score: 80, matched: true, explanation: `${input.employeeCount} employees fits range` };
    } else {
      dimensions.company_size = { score: 20, matched: false, explanation: `${input.employeeCount} employees outside range` };
    }
  } else {
    dimensions.company_size = { score: 50, matched: true, explanation: "Employee count unknown" };
  }

  dimensions.title = { score: 50, matched: true, explanation: "Title not evaluated in local fallback" };

  const intentScore = Math.min(100, (input.signals?.length ?? 0) * 25);
  dimensions.signals = (input.signals?.length ?? 0) > 0
    ? { score: intentScore, matched: true, explanation: `${input.signals!.length} signal(s): ${input.signals!.join(", ")}` }
    : { score: 0, matched: false, explanation: "No intent signals detected" };

  const icpScore = Math.max(0, Math.min(100, score));
  const reasons = Object.entries(dimensions)
    .filter(([k, d]) => d.matched && k !== "signals" && !d.explanation.includes("not specified") && !d.explanation.includes("unknown") && !d.explanation.includes("not evaluated"))
    .map(([, d]) => d.explanation);

  return {
    prospectId: input.prospectId,
    icpScore,
    icpBand: BANDS(icpScore),
    intentScore,
    painPoints: [],
    outreachReadiness: READINESS(icpScore, intentScore),
    reasoning: reasons.join("; ") || "baseline score",
    source: "heuristic",
    dimensions,
  };
}

function buildSystemPrompt(icp: IcpConfig): string {
  const lines = [
    "You are a B2B sales intelligence engine. Score a prospect against the ICP below.",
    "Return JSON with keys: icp_score (0-100), intent_score (0-100), reasoning (string),",
    "pain_points (string[]), and dimensions (object with keys: industry, seniority, geography,",
    "company_size, title, signals — each having score (0-100), matched (bool), explanation (string)).",
    "",
    "ICP CONFIGURATION:",
    `industries: ${icp.industries?.join(", ") || "any"}`,
    `countries: ${icp.countries?.join(", ") || "any"}`,
    `seniorities: ${icp.seniorities?.join(", ") || "any"}`,
    `titles: ${icp.titles?.join(", ") || "any"}`,
    `keywords: ${icp.keywords?.join(", ") || "none"}`,
    `employee range: ${icp.minEmployees ?? 0} – ${icp.maxEmployees ?? "unlimited"}`,
  ];
  return lines.join("\n");
}

function buildUserPrompt(input: ScoreInput, baseline: ScoreResult): string {
  return JSON.stringify({
    prospect_id: input.prospectId,
    full_name: input.fullName,
    title: input.title,
    seniority: input.seniority,
    industry: input.industry,
    country: input.country,
    employee_count: input.employeeCount,
    company_domain: input.companyDomain,
    signals: input.signals ?? [],
    baseline_icp_score: baseline.icpScore,
    baseline_intent_score: baseline.intentScore,
  });
}

function parseDimensions(raw: unknown, fallback: Record<string, DimensionScore>): Record<string, DimensionScore> {
  if (!raw || typeof raw !== "object") return fallback;
  const result: Record<string, DimensionScore> = { ...fallback };
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val && typeof val === "object") {
      const v = val as Record<string, unknown>;
      result[key] = {
        score: Math.max(0, Math.min(100, Number(v.score ?? fallback[key]?.score ?? 50))),
        matched: Boolean(v.matched ?? fallback[key]?.matched ?? false),
        explanation: String(v.explanation ?? fallback[key]?.explanation ?? ""),
      };
    }
  }
  return result;
}

async function scoreWithLLM(
  input: ScoreInput,
  icp: IcpConfig,
  timeoutMs: number,
  openrouterApiKey?: string
): Promise<ScoreResult> {
  const { default: OpenAI } = await import("openai");

  const client = new OpenAI({
    apiKey: openrouterApiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: timeoutMs,
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });

  const model = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
  const baseline = scoreLocally(input, icp);

  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt(icp) },
      { role: "user", content: buildUserPrompt(input, baseline) },
    ],
  });

  const data = JSON.parse(res.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
  const icpScore = Math.max(0, Math.min(100, Number(data.icp_score ?? baseline.icpScore)));
  const intentScore = Math.max(0, Math.min(100, Number(data.intent_score ?? baseline.intentScore)));
  const rawPain = data.pain_points;
  const painPoints = Array.isArray(rawPain) ? rawPain.map(String).filter(Boolean) : baseline.painPoints;

  return {
    prospectId: input.prospectId,
    icpScore,
    icpBand: BANDS(icpScore),
    intentScore,
    painPoints,
    outreachReadiness: READINESS(icpScore, intentScore),
    reasoning: String(data.reasoning ?? baseline.reasoning),
    source: "llm",
    dimensions: parseDimensions(data.dimensions, baseline.dimensions),
  };
}

/** Calls LLM directly (OpenRouter / Google / OpenAI) or Python AI service, with heuristic fallback. */
export async function scoreProspect(
  aiServiceUrl: string | undefined,
  input: ScoreInput,
  icp: IcpConfig = {},
  timeoutMs = 5000,
  openrouterApiKey?: string
): Promise<ScoreResult> {
  // Direct LLM path (no Python service needed)
  if (!aiServiceUrl && openrouterApiKey) {
    try {
      return await scoreWithLLM(input, icp, timeoutMs, openrouterApiKey);
    } catch (err) {
      console.error("[scoreProspect] LLM failed, falling back to heuristic:", err);
      return scoreLocally(input, icp);
    }
  }

  if (!aiServiceUrl) return scoreLocally(input, icp);

  // Python AI service path
  try {
    const res = await fetch(`${aiServiceUrl}/v1/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prospect: {
          prospect_id: input.prospectId,
          full_name: input.fullName,
          title: input.title,
          seniority: input.seniority,
          industry: input.industry,
          country: input.country,
          employee_count: input.employeeCount,
          company_domain: input.companyDomain,
          signals: input.signals ?? [],
        },
        icp: {
          industries: icp.industries ?? [],
          countries: icp.countries ?? [],
          seniorities: icp.seniorities ?? [],
          titles: icp.titles ?? [],
          keywords: icp.keywords ?? [],
          min_employees: icp.minEmployees,
          max_employees: icp.maxEmployees,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return scoreLocally(input, icp);
    const data = (await res.json()) as Record<string, unknown>;
    const localFallback = scoreLocally(input, icp);
    return {
      prospectId: String(data.prospect_id ?? input.prospectId),
      icpScore: Number(data.icp_score ?? 0),
      icpBand: String(data.icp_band ?? "weak"),
      intentScore: Number(data.intent_score ?? 0),
      painPoints: (data.pain_points as string[]) ?? [],
      outreachReadiness: String(data.outreach_readiness ?? "nurture"),
      reasoning: String(data.reasoning ?? ""),
      source: data.source === "llm" ? "llm" : "heuristic",
      dimensions: parseDimensions(data.dimensions, localFallback.dimensions),
    };
  } catch {
    return scoreLocally(input, icp);
  }
}
