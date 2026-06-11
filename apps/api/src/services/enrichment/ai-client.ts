export interface ScoreInput {
  prospectId: string;
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
  minEmployees?: number;
  maxEmployees?: number;
}

export interface ScoreResult {
  prospectId: string;
  icpScore: number;
  icpBand: string;
  intentScore: number;
  painPoints: string[];
  outreachReadiness: string;
  reasoning: string;
}

const BANDS = (s: number) => (s >= 75 ? "strong" : s >= 45 ? "medium" : "weak");
const READINESS = (icp: number, intent: number) =>
  icp >= 75 && intent >= 60 ? "ready" : icp >= 60 ? "warm" : icp >= 40 ? "nurture" : "not_qualified";

/** Local deterministic fallback mirroring apps/ai /v1/score (strategy §9). */
export function scoreLocally(input: ScoreInput, icp: IcpConfig = {}): ScoreResult {
  let score = 40;
  const reasons: string[] = [];
  if (icp.industries?.length && input.industry) {
    if (icp.industries.includes(input.industry)) {
      score += 20;
      reasons.push("industry match");
    } else score -= 10;
  }
  if (icp.seniorities?.length && input.seniority && icp.seniorities.includes(input.seniority)) {
    score += 15;
    reasons.push("seniority match");
  }
  if (icp.countries?.length && input.country) {
    if (icp.countries.includes(input.country)) {
      score += 10;
      reasons.push("geo match");
    } else score -= 5;
  }
  if (input.employeeCount != null) {
    const lo = icp.minEmployees ?? 0;
    const hi = icp.maxEmployees ?? Number.MAX_SAFE_INTEGER;
    if (input.employeeCount >= lo && input.employeeCount <= hi) {
      score += 10;
      reasons.push("size fit");
    }
  }
  const icpScore = Math.max(0, Math.min(100, score));
  const intentScore = Math.min(100, (input.signals?.length ?? 0) * 25);
  return {
    prospectId: input.prospectId,
    icpScore,
    icpBand: BANDS(icpScore),
    intentScore,
    painPoints: [],
    outreachReadiness: READINESS(icpScore, intentScore),
    reasoning: reasons.join(", ") || "baseline score",
  };
}

/** Calls the Python AI service; falls back to local scoring on any failure. */
export async function scoreProspect(
  aiServiceUrl: string | undefined,
  input: ScoreInput,
  icp: IcpConfig = {},
  timeoutMs = 5000
): Promise<ScoreResult> {
  if (!aiServiceUrl) return scoreLocally(input, icp);
  try {
    const res = await fetch(`${aiServiceUrl}/v1/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prospect: {
          prospect_id: input.prospectId,
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
          min_employees: icp.minEmployees,
          max_employees: icp.maxEmployees,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return scoreLocally(input, icp);
    const data = (await res.json()) as Record<string, unknown>;
    return {
      prospectId: String(data.prospect_id ?? input.prospectId),
      icpScore: Number(data.icp_score ?? 0),
      icpBand: String(data.icp_band ?? "weak"),
      intentScore: Number(data.intent_score ?? 0),
      painPoints: (data.pain_points as string[]) ?? [],
      outreachReadiness: String(data.outreach_readiness ?? "nurture"),
      reasoning: String(data.reasoning ?? ""),
    };
  } catch {
    return scoreLocally(input, icp);
  }
}
