import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@skout/db";
import { normalizeDomain } from "@skout/shared";
import type { Env } from "../../config/env.js";
import type { IcpConfig, ScoreInput, ScoreResult } from "../../services/enrichment/ai-client.js";
import { scoreProspectIcp } from "../../services/intelligence-layer.service.js";
import { getWorkspaceIcp, isIcpConfigured } from "../../services/icp.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicEndpoint } from "../pipeline.js";
import { loadPerson } from "./people.js";

/**
 * POST /scores (PAPI-059, public API PRD §7.3, §8).
 *
 * Scores up to 100 people or companies against the workspace's ICP, with the same scorer as the
 * app (AI service, else the LLM, else the local heuristic). Priced scores.score per record, which
 * follows the app's enrichment.score_credit_cost unless an API price is set; charged only for
 * records that were scored. A record given as a person_id is filled from Skout's index. Scores are
 * returned, not saved to the workspace.
 */
export const SCORES_MAX = 100;

export interface PublicScore {
  /** The caller's own reference for the record, echoed back. */
  ref: string | null;
  person_id: string | null;
  type: "person" | "company";
  score: number;
  band: string;
  intent_score: number;
  readiness: string;
  reasoning: string;
  pain_points: string[];
}

export interface FailedScore {
  ref: string | null;
  person_id: string | null;
  type: "person" | "company";
  error: "not_found" | "scoring_failed";
}

export interface ScoresResponse {
  results: (PublicScore | FailedScore)[];
  scored: number;
  failed: number;
}

export interface ScoresDeps {
  env: Env;
  db: Db;
  /** The scorer; tests inject a fake one. */
  score?: (input: ScoreInput, icp: IcpConfig) => Promise<ScoreResult>;
  loadIcp?: (workspaceId: string) => Promise<IcpConfig>;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const record = z
  .object({
    ref: text(100).optional(),
    type: z.enum(["person", "company"]).default("person"),
    person_id: z.string().min(1).max(600).optional(),
    full_name: text(200).optional(),
    title: text(200).optional(),
    seniority: text(80).optional(),
    company_name: text(200).optional(),
    company_domain: text(253).optional(),
    industry: text(120).optional(),
    country: text(80).optional(),
    employee_count: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict()
  .refine((r) => r.type === "person" || !r.person_id, { message: "person_id is for person records" })
  .refine((r) => r.type === "person" || !(r.full_name || r.title || r.seniority), {
    message: "A company record takes company fields only (company_name, company_domain, industry, country, employee_count)",
  })
  .refine(
    (r) => Boolean(r.person_id || r.title || r.seniority || r.company_domain || r.company_name || r.industry || r.employee_count !== undefined),
    { message: "Give person_id, or something to score on (title, seniority, company, industry or employee_count)" }
  );

const scoresInput = z.object({ records: z.array(record).min(1).max(SCORES_MAX) }).strict();
type ScoreRecord = z.infer<typeof record>;

/** A stable id for a record the caller sent as fields (the scorer keys its cache on it). */
const recordKey = (r: ScoreRecord) =>
  createHash("sha256")
    .update(JSON.stringify([r.type, r.full_name, r.title, r.seniority, r.company_name, r.company_domain, r.industry, r.country, r.employee_count]))
    .digest("hex");

export function createScoresEndpoint(deps: ScoresDeps): PublicEndpoint<typeof scoresInput, ScoresResponse> {
  const score =
    deps.score ??
    ((input: ScoreInput, icp: IcpConfig) =>
      scoreProspectIcp(deps.env.AI_SERVICE_URL, input, icp, deps.env.ENRICHMENT_AI_TIMEOUT_MS ?? 5000, deps.env.OPENROUTER_API_KEY));
  const loadIcp = deps.loadIcp ?? ((ws: string) => getWorkspaceIcp(deps.db, ws));
  return {
    method: "POST",
    path: "/scores",
    scope: "scores:write",
    operation: "scores.score",
    input: scoresInput,
    maxCost: (input, prices) => input.records.length * prices["scores.score"].credits,

    async handle({ input, workspaceId, prices, ids }) {
      const icp = await loadIcp(workspaceId);
      if (!isIcpConfigured(icp)) {
        throw new PublicApiError("invalid_request", "Set up your ideal customer profile (ICP) in Skout before scoring. Nothing was charged.");
      }

      const scoreOne = async (r: ScoreRecord): Promise<PublicScore | FailedScore> => {
        const base = { ref: r.ref ?? null, person_id: r.person_id ?? null, type: r.type };
        let input: ScoreInput;
        if (r.person_id) {
          const prospectId = ids.decode("person", r.person_id);
          const doc = prospectId ? await loadPerson(deps, workspaceId, prospectId).catch(() => null) : null;
          if (!doc) return { ...base, error: "not_found" };
          input = {
            prospectId: prospectId!,
            fullName: doc.fullName,
            title: r.title ?? doc.title,
            seniority: r.seniority ?? doc.seniority,
            industry: r.industry ?? doc.industry,
            country: r.country ?? doc.country,
            employeeCount: r.employee_count ?? doc.employeeCount,
            companyDomain: r.company_domain ? normalizeDomain(r.company_domain) : doc.companyDomain,
          };
        } else {
          input = {
            prospectId: recordKey(r),
            fullName: r.full_name,
            title: r.title,
            seniority: r.seniority,
            industry: r.industry,
            country: r.country,
            employeeCount: r.employee_count,
            companyDomain: r.company_domain ? normalizeDomain(r.company_domain) : undefined,
          };
        }
        try {
          const s = await score(input, icp);
          return {
            ...base,
            score: Math.round(s.icpScore),
            band: s.icpBand,
            intent_score: Math.round(s.intentScore),
            readiness: s.outreachReadiness,
            reasoning: s.reasoning,
            pain_points: s.painPoints ?? [],
          };
        } catch {
          return { ...base, error: "scoring_failed" };
        }
      };

      const results: (PublicScore | FailedScore)[] = [];
      for (let i = 0; i < input.records.length; i += 5) {
        results.push(...(await Promise.all(input.records.slice(i, i + 5).map(scoreOne))));
      }
      const scored = results.filter((r) => !("error" in r)).length;
      if (scored === 0 && results.every((r) => "error" in r && r.error === "scoring_failed")) {
        throw new PublicApiError("upstream_unavailable", "Scoring is temporarily unavailable. Nothing was charged; try again.");
      }
      return { data: { results, scored, failed: results.length - scored }, charge: scored * prices["scores.score"].credits };
    },

    fixture: (input) => ({
      results: input.records.map((r, i) => ({
        ref: r.ref ?? null,
        person_id: r.person_id ?? null,
        type: r.type,
        score: 80 - i,
        band: "strong",
        intent_score: 60,
        readiness: "warm",
        reasoning: "Test key: a fixed example score.",
        pain_points: [],
      })),
      scored: input.records.length,
      failed: 0,
    }),
  };
}
