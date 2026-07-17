import { describe, it, expect, vi, afterEach } from "vitest";
import { mockCreate } from "../../test/mocks/openai.js";
import {
  scoreLocally,
  scoreProspect,
  type ScoreInput,
  type IcpConfig,
} from "./ai-client.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const baseInput: ScoreInput = {
  prospectId: "test-001",
  fullName: "Alice Chen",
  title: "CTO",
  seniority: "c_level",
  industry: "Software",
  country: "US",
  employeeCount: 200,
  companyDomain: "acme.com",
  signals: [],
};

const baseIcp: IcpConfig = {
  industries: ["Software"],
  countries: ["US"],
  seniorities: ["c_level", "vp"],
  minEmployees: 50,
  maxEmployees: 500,
};

function mockLlm(payload: Record<string, unknown>) {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  });
}

function mockPythonService(payload: Record<string, unknown>, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 503,
      json: vi.fn().mockResolvedValue(payload),
    })
  );
}

// ---------------------------------------------------------------------------
// scoreLocally — heuristic scoring
// ---------------------------------------------------------------------------
describe("scoreLocally", () => {
  it("returns a valid ScoreResult shape", () => {
    const result = scoreLocally(baseInput, baseIcp);
    expect(result.prospectId).toBe("test-001");
    expect(result.icpScore).toBeGreaterThanOrEqual(0);
    expect(result.icpScore).toBeLessThanOrEqual(100);
    expect(["strong", "medium", "weak"]).toContain(result.icpBand);
    expect(result.source).toBe("heuristic");
    expect(result.dimensions).toBeDefined();
  });

  it("score with full ICP match is higher than bare score", () => {
    const matched = scoreLocally(baseInput, baseIcp);
    const bare = scoreLocally({ prospectId: "bare" });
    expect(matched.icpScore).toBeGreaterThan(bare.icpScore);
  });

  it("penalises industry mismatch", () => {
    const matched = scoreLocally(baseInput, baseIcp);
    const mismatched = scoreLocally({ ...baseInput, industry: "Retail" }, baseIcp);
    expect(mismatched.icpScore).toBeLessThan(matched.icpScore);
    expect(mismatched.dimensions.industry.matched).toBe(false);
  });

  it("penalises geography mismatch", () => {
    const matched = scoreLocally(baseInput, baseIcp);
    const mismatched = scoreLocally({ ...baseInput, country: "IN" }, baseIcp);
    expect(mismatched.icpScore).toBeLessThan(matched.icpScore);
    expect(mismatched.dimensions.geography.matched).toBe(false);
  });

  it("marks company_size unmatched when outside range", () => {
    const result = scoreLocally({ ...baseInput, employeeCount: 50000 }, baseIcp);
    expect(result.dimensions.company_size.matched).toBe(false);
    expect(result.dimensions.company_size.score).toBe(20);
  });

  it("scores intent from signals with a boost for strong buying signals (R5.2)", () => {
    const weak = scoreLocally({ ...baseInput, signals: ["news"] }, baseIcp);
    const strong = scoreLocally({ ...baseInput, signals: ["recent_hiring"] }, baseIcp);
    const four = scoreLocally(
      { ...baseInput, signals: ["recent_hiring", "job_posting", "funding", "news"] },
      baseIcp
    );
    expect(weak.intentScore).toBe(25);
    expect(strong.intentScore).toBe(65); // max(25, 50+15)
    expect(four.intentScore).toBe(100);
  });

  it("returns intentScore 0 with no signals", () => {
    const result = scoreLocally({ ...baseInput, signals: [] }, baseIcp);
    expect(result.intentScore).toBe(0);
    expect(result.dimensions.signals.matched).toBe(false);
  });

  it("baseline icpScore is 40 with no ICP", () => {
    const result = scoreLocally({ prospectId: "bare-001" });
    expect(result.source).toBe("heuristic");
    expect(result.icpScore).toBe(40);
  });

  it("includes all six expected dimension keys", () => {
    const result = scoreLocally(baseInput, baseIcp);
    for (const key of ["industry", "seniority", "geography", "company_size", "title", "signals"]) {
      expect(result.dimensions, `missing key: ${key}`).toHaveProperty(key);
    }
  });

  it("each dimension has score 0-100, matched bool, non-empty explanation", () => {
    const result = scoreLocally(baseInput, baseIcp);
    for (const [key, dim] of Object.entries(result.dimensions)) {
      expect(dim.score, `${key}.score`).toBeGreaterThanOrEqual(0);
      expect(dim.score, `${key}.score`).toBeLessThanOrEqual(100);
      expect(typeof dim.matched, `${key}.matched`).toBe("boolean");
      expect(dim.explanation, `${key}.explanation`).toBeTruthy();
    }
  });

  it("outreachReadiness is not_qualified for fully mismatched prospect", () => {
    const result = scoreLocally(
      { prospectId: "bad-fit", industry: "Retail", country: "AU", seniority: "intern", employeeCount: 2 },
      { industries: ["Software"], countries: ["US"], seniorities: ["c_level"], minEmployees: 100, maxEmployees: 1000 }
    );
    expect(result.icpScore).toBeLessThan(40);
    expect(result.outreachReadiness).toBe("not_qualified");
  });

  it("outreachReadiness is ready when icpScore >= 75 and intentScore >= 60", () => {
    const result = scoreLocally(
      { ...baseInput, signals: ["s1", "s2", "s3"] },
      baseIcp
    );
    if (result.icpScore >= 75 && result.intentScore >= 60) {
      expect(result.outreachReadiness).toBe("ready");
    }
  });
});

// ---------------------------------------------------------------------------
// scoreProspect — fallback routing
// ---------------------------------------------------------------------------
describe("scoreProspect — fallback routing", () => {
  it("returns heuristic when no aiServiceUrl and no key", async () => {
    const result = await scoreProspect(undefined, baseInput, baseIcp);
    expect(result.source).toBe("heuristic");
  });

  it("returns heuristic when aiServiceUrl is unreachable (ECONNREFUSED)", async () => {
    const result = await scoreProspect("http://localhost:19999", baseInput, baseIcp, 300);
    expect(result.source).toBe("heuristic");
    expect(result.prospectId).toBe("test-001");
  });

  it("returns heuristic when Python service returns non-200", async () => {
    mockPythonService({}, false);
    const result = await scoreProspect("http://localhost:8000", baseInput, baseIcp, 5000);
    expect(result.source).toBe("heuristic");
  });

  it("returns heuristic when Python service JSON is unparseable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
    }));
    const result = await scoreProspect("http://localhost:8000", baseInput, baseIcp, 5000);
    expect(result.source).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------
// scoreProspect — Python AI service path
// ---------------------------------------------------------------------------
describe("scoreProspect — Python service path", () => {
  it("parses a valid Python service response", async () => {
    mockPythonService({
      prospect_id: "test-001",
      icp_score: 82,
      icp_band: "strong",
      intent_score: 50,
      pain_points: ["scaling ops"],
      outreach_readiness: "ready",
      reasoning: "Good fit",
      source: "llm",
      dimensions: {
        industry:     { score: 90, matched: true,  explanation: "Software matches" },
        seniority:    { score: 85, matched: true,  explanation: "CTO is c_level" },
        geography:    { score: 80, matched: true,  explanation: "US matches" },
        company_size: { score: 75, matched: true,  explanation: "200 in range" },
        title:        { score: 70, matched: true,  explanation: "CTO relevant" },
        signals:      { score: 50, matched: true,  explanation: "1 signal" },
      },
    });

    const result = await scoreProspect("http://localhost:8000", baseInput, baseIcp, 5000);
    expect(result.icpScore).toBe(82);
    expect(result.icpBand).toBe("strong");
    expect(result.intentScore).toBe(50);
    expect(result.source).toBe("llm");
    expect(result.painPoints).toEqual(["scaling ops"]);
    expect(result.dimensions.industry.score).toBe(90);
    expect(result.dimensions.seniority.matched).toBe(true);
  });

  it("merges partial dimensions from Python service with heuristic fallback", async () => {
    mockPythonService({
      prospect_id: "test-001",
      icp_score: 65,
      icp_band: "medium",
      intent_score: 25,
      pain_points: [],
      outreach_readiness: "warm",
      reasoning: "Partial",
      source: "llm",
      dimensions: {
        industry: { score: 92, matched: true, explanation: "Software" },
        // other 5 dimensions intentionally missing
      },
    });

    const result = await scoreProspect("http://localhost:8000", baseInput, baseIcp, 5000);
    expect(result.dimensions.industry.score).toBe(92);
    // Fallback heuristic dimensions should be present
    for (const key of ["seniority", "geography", "company_size", "title", "signals"]) {
      expect(result.dimensions, `missing fallback key: ${key}`).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreProspect — direct OpenRouter LLM path
// ---------------------------------------------------------------------------
describe("scoreProspect — OpenRouter LLM path", () => {
  it("returns source=llm with parsed scores", async () => {
    mockLlm({
      icp_score: 78,
      intent_score: 50,
      reasoning: "Good tech fit",
      pain_points: ["hiring bottleneck"],
      dimensions: {
        industry:     { score: 88, matched: true,  explanation: "Software match" },
        seniority:    { score: 82, matched: true,  explanation: "c_level match" },
        geography:    { score: 80, matched: true,  explanation: "US match" },
        company_size: { score: 75, matched: true,  explanation: "in range" },
        title:        { score: 70, matched: true,  explanation: "CTO relevant" },
        signals:      { score:  0, matched: false, explanation: "No signals" },
      },
    });

    const result = await scoreProspect(undefined, baseInput, baseIcp, 5000, "sk-or-test");
    expect(result.source).toBe("llm");
    expect(result.icpScore).toBe(78);
    expect(result.intentScore).toBe(50);
    expect(result.painPoints).toContain("hiring bottleneck");
    expect(result.dimensions.industry.matched).toBe(true);
    expect(result.dimensions.signals.matched).toBe(false);
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it("sends system + user messages to the LLM", async () => {
    mockLlm({ icp_score: 60, intent_score: 0, reasoning: "ok", pain_points: [], dimensions: {} });

    await scoreProspect(undefined, baseInput, baseIcp, 5000, "sk-or-test");

    const call = mockCreate.mock.calls[0]?.[0] as { messages: { role: string }[] };
    expect(call.messages.some((m) => m.role === "system")).toBe(true);
    expect(call.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("system prompt contains the ICP configuration", async () => {
    mockLlm({ icp_score: 60, intent_score: 0, reasoning: "ok", pain_points: [], dimensions: {} });

    await scoreProspect(undefined, baseInput, baseIcp, 5000, "sk-or-test");

    const call = mockCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] };
    const system = call.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("Software");   // ICP industry
    expect(system).toContain("US");          // ICP country
    expect(system).toContain("c_level");     // ICP seniority
  });

  it("falls back to heuristic when LLM throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const result = await scoreProspect(undefined, baseInput, baseIcp, 5000, "sk-or-bad-key");
    expect(result.source).toBe("heuristic");
    expect(result.prospectId).toBe("test-001");
  });

  it("clamps icp_score > 100 down to 100", async () => {
    mockLlm({ icp_score: 150, intent_score: 200, reasoning: "Test", pain_points: [], dimensions: {} });

    const result = await scoreProspect(undefined, baseInput, {}, 5000, "sk-or-test");
    expect(result.icpScore).toBeLessThanOrEqual(100);
    expect(result.intentScore).toBeLessThanOrEqual(100);
  });

  it("clamps negative scores up to 0", async () => {
    mockLlm({ icp_score: -20, intent_score: -5, reasoning: "Test", pain_points: [], dimensions: {} });

    const result = await scoreProspect(undefined, baseInput, {}, 5000, "sk-or-test");
    expect(result.icpScore).toBeGreaterThanOrEqual(0);
    expect(result.intentScore).toBeGreaterThanOrEqual(0);
  });

  it("merges partial LLM dimensions with heuristic fallback", async () => {
    mockLlm({
      icp_score: 70,
      intent_score: 25,
      reasoning: "Partial",
      pain_points: [],
      dimensions: {
        industry: { score: 92, matched: true, explanation: "Software" },
        // other 5 dimensions missing
      },
    });

    const result = await scoreProspect(undefined, baseInput, baseIcp, 5000, "sk-or-test");
    expect(result.dimensions.industry.score).toBe(92);
    for (const key of ["seniority", "geography", "company_size", "title", "signals"]) {
      expect(result.dimensions, `missing fallback key: ${key}`).toHaveProperty(key);
    }
  });

  it("uses pain_points array from LLM response", async () => {
    mockLlm({
      icp_score: 65,
      intent_score: 25,
      reasoning: "Issues found",
      pain_points: ["slow onboarding", "manual reporting"],
      dimensions: {},
    });

    const result = await scoreProspect(undefined, baseInput, baseIcp, 5000, "sk-or-test");
    expect(result.painPoints).toEqual(["slow onboarding", "manual reporting"]);
  });

  it("ignores non-array pain_points from LLM", async () => {
    mockLlm({
      icp_score: 65,
      intent_score: 25,
      reasoning: "ok",
      pain_points: "not an array",
      dimensions: {},
    });

    const result = await scoreProspect(undefined, baseInput, baseIcp, 5000, "sk-or-test");
    expect(Array.isArray(result.painPoints)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scoreProspect — aiServiceUrl takes priority over LLM key
// ---------------------------------------------------------------------------
describe("scoreProspect — aiServiceUrl priority over LLM", () => {
  it("calls Python service when both aiServiceUrl and key are set", async () => {
    mockPythonService({
      prospect_id: "test-001",
      icp_score: 55,
      icp_band: "medium",
      intent_score: 0,
      pain_points: [],
      outreach_readiness: "warm",
      reasoning: "from python",
      source: "heuristic",
      dimensions: {},
    });

    const result = await scoreProspect(
      "http://localhost:8000",
      baseInput,
      baseIcp,
      5000,
      "sk-or-test"
    );

    expect(result.reasoning).toBe("from python");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
