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
  jobPosts?: { title: string; department?: string }[];
}

export type IntentType = "in_market" | "researching" | "not_ready" | "unknown";

export interface IntentClassification {
  intent: IntentType;
  intentScore: number;
  confidence: number;
  rationale: string;
  signalsUsed: string[];
  outreachReadiness: string;
  requiresHitl: boolean;
}

export interface IcpConfig {
  industries?: string[];
  countries?: string[];
  seniorities?: string[];
  titles?: string[];
  keywords?: string[];
  minEmployees?: number;
  maxEmployees?: number;
  companyName?: string;
  productDescription?: string;
  customerPainPoints?: string[];
  /** When false, saving ICP does not enqueue a workspace-wide re-score. Default: true. */
  autoRescoreOnChange?: boolean;
  /** Raw answers captured by the signup onboarding wizard (stored alongside the derived ICP). */
  onboarding?: OnboardingProfile;
}

/** Structured answers from the signup onboarding wizard. */
export interface OnboardingProfile {
  company?: {
    name?: string;
    industry?: string;
    size?: string;
    website?: string;
  };
  goals?: string[];
  icp?: {
    industries?: string[];
    employeeRanges?: string[];
    countries?: string[];
    revenue?: string;
  };
  people?: {
    departments?: string[];
    seniorities?: string[];
    titles?: string[];
  };
  market?: string[];
  crm?: string;
  leadVolume?: string;
  completedAt?: string;
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
  painPointsRationale: string | null;
  outreachReadiness: string;
  reasoning: string;
  source: "llm" | "heuristic";
  creditsUsed?: number;
  dimensions: Record<string, DimensionScore>;
  intentClassification?: IntentClassification;
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

  // Signals / intent — mirrors apps/ai _intent_score_from_signals (R5.2)
  const signals = input.signals ?? [];
  let intentScore = Math.min(100, signals.length * 25);
  const strong = new Set(["recent_funding", "recent_hiring", "product_launch", "market_expansion"]);
  const strongCount = signals.filter((s) => strong.has(s)).length;
  if (strongCount > 0) {
    intentScore = Math.min(100, Math.max(intentScore, 50 + 15 * strongCount));
  }
  dimensions.signals =
    signals.length > 0
      ? { score: intentScore, matched: true, explanation: `${signals.length} signal(s): ${signals.join(", ")}` }
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
    painPointsRationale: null,
    outreachReadiness: READINESS(icpScore, intentScore),
    reasoning: reasons.join("; ") || "baseline score",
    source: "heuristic",
    dimensions,
  };
}

const PAIN_POINT_ENUM = [
  "scaling", "hiring", "tooling", "technical_debt", "data_quality",
  "compliance", "cost_reduction", "integration", "customer_retention",
  "pipeline", "reporting", "onboarding",
] as const;

function buildSystemPrompt(icp: IcpConfig): string {
  const lines = [
    "You are a B2B sales intelligence engine. Score a prospect against the ICP below.",
    "Return JSON with keys: icp_score (0-100), intent_score (0-100), reasoning (string),",
    `pain_points (string[] — pick only values from: ${PAIN_POINT_ENUM.join(", ")}),`,
    "pain_rationale (string — one sentence explaining which signals led to each pain point),",
    "and dimensions (object with keys: industry, seniority, geography,",
    "company_size, title, signals — each having score (0-100), matched (bool), explanation (string)).",
    "",
    "ICP CONFIGURATION:",
    `seller_company: ${icp.companyName || "not specified"}`,
    `product: ${icp.productDescription || "not specified"}`,
    `customer_pains_solved: ${icp.customerPainPoints?.join(", ") || "none"}`,
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
  const painPoints = Array.isArray(rawPain)
    ? rawPain.map(String).filter((p) => (PAIN_POINT_ENUM as readonly string[]).includes(p))
    : [];
  const painPointsRationale = typeof data.pain_rationale === "string" && data.pain_rationale
    ? data.pain_rationale
    : null;

  return {
    prospectId: input.prospectId,
    icpScore,
    icpBand: BANDS(icpScore),
    intentScore,
    painPoints,
    painPointsRationale,
    outreachReadiness: READINESS(icpScore, intentScore),
    reasoning: String(data.reasoning ?? baseline.reasoning),
    source: "llm",
    dimensions: parseDimensions(data.dimensions, baseline.dimensions),
  };
}

const HITL_CONFIDENCE_THRESHOLD = 0.65;

/**
 * Calls the Python AI service /v1/classify for model-derived buying-intent classification.
 * Returns null when the service is unavailable — caller falls back to heuristic intent.
 */
export async function classifyIntent(
  aiServiceUrl: string,
  input: ScoreInput,
  timeoutMs: number
): Promise<IntentClassification | null> {
  try {
    const res = await fetch(`${aiServiceUrl}/v1/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prospect_id: input.prospectId,
        signals: (input.signals ?? []).map((s) => ({ type: s })),
        firmographics: {
          industry: input.industry,
          employee_count: input.employeeCount,
          country: input.country,
          company_domain: input.companyDomain,
          title: input.title,
          seniority: input.seniority,
        },
        job_posts: (input.jobPosts ?? []).map((j) => ({ title: j.title, department: j.department })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const intent = (["in_market", "researching", "not_ready", "unknown"].includes(String(data.intent))
      ? data.intent
      : "unknown") as IntentType;
    const intentScore = Math.max(0, Math.min(100, Number(data.intent_score ?? 0)));
    const confidence = Math.max(0, Math.min(1, Number(data.confidence ?? 0)));
    return {
      intent,
      intentScore,
      confidence,
      rationale: String(data.rationale ?? ""),
      signalsUsed: Array.isArray(data.signals_used) ? data.signals_used.map(String) : [],
      outreachReadiness: String(data.outreach_readiness ?? "nurture"),
      requiresHitl: confidence < HITL_CONFIDENCE_THRESHOLD,
    };
  } catch {
    return null;
  }
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

  // Python AI service path — call /v1/score for ICP + /v1/classify for intent in parallel
  try {
    const [scoreRes, intentResult] = await Promise.all([
      fetch(`${aiServiceUrl}/v1/score`, {
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
            company_name: icp.companyName,
            product_description: icp.productDescription,
            customer_pain_points: icp.customerPainPoints ?? [],
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      classifyIntent(aiServiceUrl, input, timeoutMs),
    ]);

    if (!scoreRes.ok) return scoreLocally(input, icp);
    const data = (await scoreRes.json()) as Record<string, unknown>;
    const localFallback = scoreLocally(input, icp);

    // Intent from /v1/classify takes precedence over /v1/score's intent_score
    const intentScore = intentResult
      ? intentResult.intentScore
      : Number(data.intent_score ?? 0);
    const outreachReadiness = intentResult
      ? (intentResult.requiresHitl ? "nurture" : intentResult.outreachReadiness)
      : String(data.outreach_readiness ?? "nurture");

    const rawAiPain = data.pain_points;
    const aiPainPoints = Array.isArray(rawAiPain)
      ? rawAiPain.map(String).filter((p) => (PAIN_POINT_ENUM as readonly string[]).includes(p))
      : [];
    const aiPainRationale = typeof data.pain_rationale === "string" && data.pain_rationale
      ? data.pain_rationale
      : null;

    return {
      prospectId: String(data.prospect_id ?? input.prospectId),
      icpScore: Number(data.icp_score ?? 0),
      icpBand: String(data.icp_band ?? "weak"),
      intentScore,
      painPoints: aiPainPoints,
      painPointsRationale: aiPainRationale,
      outreachReadiness,
      reasoning: String(data.reasoning ?? ""),
      source: data.source === "llm" ? "llm" : "heuristic",
      dimensions: parseDimensions(data.dimensions, localFallback.dimensions),
      intentClassification: intentResult ?? undefined,
    };
  } catch {
    return scoreLocally(input, icp);
  }
}
