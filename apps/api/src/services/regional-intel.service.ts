import OpenAI from "openai";

export interface RegionalBriefInput {
  location: string;
  locale?: string;
  purpose: "tam" | "territory" | "competitive" | "onboarding";
  companyIndustry?: string;
  productDescription?: string;
}

export interface RegionalBrief {
  location: string;
  locale: string | null;
  purpose: string;
  summary: string;
  marketNotes: string[];
  complianceHints: string[];
  outreachTone: string;
  territoryHints: string[];
  model: string;
  unverified: true;
}

/**
 * §16 — LLM regional briefing. Explicitly marked unverified (not evidence-ledger facts).
 */
export async function generateRegionalBrief(
  input: RegionalBriefInput,
  openRouterApiKey: string | undefined
): Promise<RegionalBrief> {
  if (!openRouterApiKey) {
    return heuristicBrief(input);
  }

  const model = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
  const client = new OpenAI({
    apiKey: openRouterApiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });

  const prompt = `You are a B2B GTM analyst. Given seller location "${input.location}" (locale: ${input.locale ?? "n/a"}), purpose=${input.purpose}, industry=${input.companyIndustry ?? "n/a"}, product=${input.productDescription ?? "n/a"}.
Return ONLY JSON with keys:
  summary (string, 2-3 sentences),
  marketNotes (string[] max 5),
  complianceHints (string[] max 4 — high-level, not legal advice),
  outreachTone (string),
  territoryHints (string[] max 5 — for sales territory / comp planning).
Do not invent specific customer names or fake deal outcomes.`;

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: "Return valid JSON only. No markdown." },
      { role: "user", content: prompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() ?? "{}";
  let parsed: Partial<RegionalBrief> = {};
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")) as Partial<RegionalBrief>;
  } catch {
    parsed = { summary: raw.slice(0, 500) };
  }

  return {
    location: input.location,
    locale: input.locale ?? null,
    purpose: input.purpose,
    summary: parsed.summary ?? "Regional brief unavailable",
    marketNotes: Array.isArray(parsed.marketNotes) ? parsed.marketNotes.slice(0, 5) : [],
    complianceHints: Array.isArray(parsed.complianceHints) ? parsed.complianceHints.slice(0, 4) : [],
    outreachTone: typeof parsed.outreachTone === "string" ? parsed.outreachTone : "professional",
    territoryHints: Array.isArray(parsed.territoryHints) ? parsed.territoryHints.slice(0, 5) : [],
    model,
    unverified: true,
  };
}

function heuristicBrief(input: RegionalBriefInput): RegionalBrief {
  return {
    location: input.location,
    locale: input.locale ?? null,
    purpose: input.purpose,
    summary: `Seller location set to ${input.location}. Configure OPENROUTER_API_KEY for full LLM regional briefing.`,
    marketNotes: [`Prioritize buyers reachable from ${input.location}.`],
    complianceHints: ["Confirm local email/consent rules before cold outreach."],
    outreachTone: "professional, locally aware",
    territoryHints: [`Seed territory around ${input.location}; refine with win-loss (§2).`],
    model: "heuristic",
    unverified: true,
  };
}
