import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { injectTraceContext } from "@skout/observability";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { pinAiClaim } from "./ai-evidence.service.js";
import { generateRegionalBrief } from "./regional-intel.service.js";

export interface PersonalizeInput {
  prospectId: string;
  fullName?: string;
  title?: string;
  companyDomain?: string;
  painPoints?: string[];
  icpScore?: number;
  /** Prospect's own country, if known — drives regional outreach tone (§10.3 / §16). */
  companyCountry?: string;
}

export interface PersonalizeResult {
  prospectId: string;
  opener: string;
  talkingPoints: string[];
  source: string;
  draftId?: string;
  subject: string;
  body: string;
  evidenceId: string | null;
  modelVersionId?: string | null;
  promptVersionId?: string | null;
}

/**
 * Generate an AI opener/talking-points draft for a prospect and store it as a pending_review
 * ai_draft — the same HITL gate `sequence-enrollment.worker.ts` already enforces before any
 * template send is overridden. Shared by the manual `/enrichment/personalize` route and the
 * signal-triggered activation-rules path (R10.3) so both produce an identically-gated draft.
 */
export async function personalizeProspect(
  db: Db | null | undefined,
  config: Env,
  workspaceId: string,
  input: PersonalizeInput
): Promise<PersonalizeResult> {
  const aiUrl = config.AI_SERVICE_URL;
  let result: Omit<PersonalizeResult, "draftId" | "subject" | "body" | "evidenceId" | "modelVersionId" | "promptVersionId">;

  // §10.3 / §16 — regional tone: cheap heuristic fallback when no key is configured, LLM-refined
  // when one is. Best-effort — a brief failure should never block draft generation.
  let regionalTone: string | undefined;
  if (input.companyCountry) {
    try {
      const brief = await generateRegionalBrief(
        { location: input.companyCountry, purpose: "territory" },
        config.OPENROUTER_API_KEY
      );
      regionalTone = brief.outreachTone;
    } catch {
      regionalTone = undefined;
    }
  }

  if (!aiUrl) {
    // No LLM configured — heuristic mode has no prompt to steer with tone, so it's recorded on
    // the result below for evidence/consistency but not literally injected into the copy.
    result = {
      prospectId: input.prospectId,
      opener: `Hi ${input.fullName ?? "there"} — reaching out about ${input.companyDomain}.`,
      talkingPoints: input.painPoints ?? [],
      source: "heuristic",
    };
  } else {
    const res = await fetch(`${aiUrl}/v1/personalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...injectTraceContext() },
      body: JSON.stringify({
        prospect_id: input.prospectId,
        full_name: input.fullName,
        title: input.title,
        company_domain: input.companyDomain,
        pain_points: input.painPoints ?? [],
        icp_score: input.icpScore,
        regional_tone: regionalTone,
      }),
      signal: AbortSignal.timeout(config.ENRICHMENT_AI_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new HttpError("ai_service_error", 502);
    } else {
      const ai = (await res.json()) as Partial<Omit<PersonalizeResult, "draftId" | "subject" | "body">>;
      result = {
        prospectId: input.prospectId,
        opener: ai.opener ?? `Hi ${input.fullName ?? "there"}`,
        talkingPoints: ai.talkingPoints ?? input.painPoints ?? [],
        source: ai.source ?? "ai",
      };
    }
  }

  const draftBody = [result.opener, ...result.talkingPoints].filter(Boolean).join("\n\n");
  const subject = `Outreach to ${input.fullName ?? input.companyDomain ?? "prospect"}`;

  let draftId: string | undefined;
  let evidenceId: string | null = null;
  let modelVersionId: string | null = null;
  let promptVersionId: string | null = null;
  if (db && workspaceId !== "unknown") {
    const [draft] = await db
      .insert(schema.aiDrafts)
      .values({
        workspaceId,
        prospectId: input.prospectId,
        subject,
        body: draftBody,
        model: result.source,
      })
      .returning({ id: schema.aiDrafts.id });
    draftId = draft?.id;

    // §6.1 / §5.1 — pin this AI claim to the evidence ledger so the draft's provenance
    // (which model/prompt version produced it) is queryable later, not just implied by
    // the draft row's `model` string.
    const pinned = await pinAiClaim(db, {
      workspaceId,
      entityType: "prospect",
      entityId: input.prospectId,
      attribute: "personalize",
      value: { opener: result.opener, talkingPoints: result.talkingPoints, draftId, regionalTone },
      source: "ai_personalize",
      method: "enrichment_personalize",
      versionName: "personalize",
    });
    evidenceId = pinned.evidenceId;
    modelVersionId = pinned.modelVersionId;
    promptVersionId = pinned.promptVersionId;
  }

  return { ...result, draftId, subject, body: draftBody, evidenceId, modelVersionId, promptVersionId };
}
