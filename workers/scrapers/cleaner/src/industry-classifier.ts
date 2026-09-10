import type { CompanyCandidate } from "@skout/scraper-contracts";

const INDUSTRY_KEYWORDS: Record<string, RegExp[]> = {
  Software: [/software/i, /saas/i, /platform/i, /cloud/i, /developer tools/i],
  "Financial Services": [/fintech/i, /banking/i, /payments/i, /insurance/i, /investment/i],
  Healthcare: [/healthcare/i, /medical/i, /pharma/i, /biotech/i, /hospital/i],
  Retail: [/retail/i, /ecommerce/i, /e-commerce/i, /marketplace/i, /consumer goods/i],
  Manufacturing: [/manufacturing/i, /industrial/i, /automotive/i, /aerospace/i],
  "Professional Services": [/consulting/i, /agency/i, /legal/i, /accounting/i],
};

const SUB_INDUSTRY_HINTS: Array<{ sub: string; pattern: RegExp }> = [
  { sub: "B2B SaaS", pattern: /b2b|enterprise software|workflow automation/i },
  { sub: "Cybersecurity", pattern: /security|cyber|infosec|soc2/i },
  { sub: "AI/ML", pattern: /artificial intelligence|machine learning|\bAI\b/i },
  { sub: "DevTools", pattern: /developer|api platform|infrastructure/i },
  { sub: "HR Tech", pattern: /human resources|recruiting|talent/i },
];

/**
 * AI-style industry classification — heuristic today, swappable for LLM via AI_SERVICE_URL.
 * Replaces static normalization with keyword + description scoring.
 */
export async function classifyIndustry(company: Pick<CompanyCandidate, "description" | "keywords" | "industry" | "companyName">): Promise<{
  industry?: string;
  subIndustry?: string;
  confidence: number;
  source: "heuristic" | "llm";
}> {
  const text = [company.companyName, company.description, company.keywords?.join(" "), company.industry]
    .filter(Boolean)
    .join(" ");

  if (!text.trim()) {
    return { confidence: 0, source: "heuristic" };
  }

  const aiUrl = process.env.AI_SERVICE_URL?.replace(/\/$/, "");
  if (aiUrl) {
    try {
      const res = await fetch(`${aiUrl}/v1/classify-industry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const body = (await res.json()) as { industry?: string; subIndustry?: string; confidence?: number };
        if (body.industry) {
          return {
            industry: body.industry,
            subIndustry: body.subIndustry,
            confidence: body.confidence ?? 0.85,
            source: "llm",
          };
        }
      }
    } catch {
      // fall through to heuristic
    }
  }

  let bestIndustry = company.industry;
  let bestScore = 0;
  for (const [industry, patterns] of Object.entries(INDUSTRY_KEYWORDS)) {
    const score = patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndustry = industry;
    }
  }

  let subIndustry: string | undefined;
  for (const hint of SUB_INDUSTRY_HINTS) {
    if (hint.pattern.test(text)) {
      subIndustry = hint.sub;
      break;
    }
  }

  return {
    industry: bestIndustry,
    subIndustry,
    confidence: bestScore > 0 ? 0.7 + bestScore * 0.05 : 0.4,
    source: "heuristic",
  };
}
