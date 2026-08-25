import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";

export interface PersonalizeInput {
  prospectId: string;
  fullName?: string;
  title?: string;
  companyDomain?: string;
  painPoints?: string[];
  icpScore?: number;
}

export interface PersonalizeResult {
  prospectId: string;
  opener: string;
  talkingPoints: string[];
  source: string;
  draftId?: string;
  subject: string;
  body: string;
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
  let result: Omit<PersonalizeResult, "draftId" | "subject" | "body">;

  if (!aiUrl) {
    result = {
      prospectId: input.prospectId,
      opener: `Hi ${input.fullName ?? "there"} — reaching out about ${input.companyDomain}.`,
      talkingPoints: input.painPoints ?? [],
      source: "heuristic",
    };
  } else {
    const res = await fetch(`${aiUrl}/v1/personalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prospect_id: input.prospectId,
        full_name: input.fullName,
        title: input.title,
        company_domain: input.companyDomain,
        pain_points: input.painPoints ?? [],
        icp_score: input.icpScore,
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
  }

  return { ...result, draftId, subject, body: draftBody };
}
