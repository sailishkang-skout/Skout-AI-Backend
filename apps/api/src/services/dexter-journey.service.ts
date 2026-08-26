import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import OpenAI from "openai";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { classifyAndRecord, assertAllowed } from "./policy-gateway.service.js";
import { incrJourneyMetric } from "./journey-metrics.js";
import { pinAiClaim } from "./ai-evidence.service.js";
import type { Env } from "../config/env.js";
import { checkLinkedinConnectionStatus } from "./linkedin-connection.service.js";
import { resolveProspectFields } from "./prospect-resolver.service.js";
import { generateRegionalBrief } from "./regional-intel.service.js";

const log = createLogger("dexter-journey");
const { dexterPlans, linkedinVoiceHandoffs, activities } = schema;

export async function proposeDexterPlan(
  db: Db,
  opts: { workspaceId: string; brief: string; userId?: string }
) {
  const classify = await classifyAndRecord(db, {
    workspaceId: opts.workspaceId,
    actionKey: "dexter.plan_invoke",
    actorUserId: opts.userId,
    detail: { phase: "propose" },
  });

  const proposal = {
    steps: [
      { id: "brief_approval", status: "pending" },
      { id: "policy_gateway_classify", status: "done", mode: classify.mode },
      { id: "post_approval_invoke", status: "blocked_until_approve" },
      { id: "outcome_hypothesis_attribution", status: "pending" },
      { id: "learning_update_threshold", status: "pending" },
    ],
    hypothesis: `Executing brief: ${opts.brief.slice(0, 200)}`,
  };

  const [plan] = await db
    .insert(dexterPlans)
    .values({
      workspaceId: opts.workspaceId,
      brief: opts.brief,
      proposal,
      status: "proposed",
      policyMode: classify.mode,
      policyDecisionId: classify.decisionId,
      createdBy: opts.userId,
    })
    .returning();

  return { plan: plan!, policy: classify };
}

export async function approveDexterPlan(db: Db, workspaceId: string, planId: string) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(and(eq(dexterPlans.id, planId), eq(dexterPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);
  if (plan.status !== "proposed") throw new HttpError(`Plan status is ${plan.status}`, 422);

  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "approved", approvedAt: new Date() })
    .where(eq(dexterPlans.id, planId))
    .returning();
  return updated!;
}

export async function invokeDexterPlan(db: Db, workspaceId: string, planId: string, userId?: string) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(and(eq(dexterPlans.id, planId), eq(dexterPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);
  if (plan.status !== "approved") {
    throw new HttpError("Dexter plan must be approved before invoke", 422);
  }

  const policy = await assertAllowed(db, {
    workspaceId,
    actionKey: "dexter.plan_invoke",
    actorUserId: userId,
    entityType: "dexter_plan",
    entityId: planId,
    priorApproval: true,
    detail: { phase: "invoke" },
  });

  const outcome = {
    invoked: true,
    at: new Date().toISOString(),
    learningHint: "threshold_unchanged",
  };

  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "invoked", invokedAt: new Date(), outcome, policyDecisionId: policy.decisionId })
    .where(eq(dexterPlans.id, planId))
    .returning();

  incrJourneyMetric("dexterPlanInvoke");
  return { plan: updated!, policy };
}

export async function recordDexterLearning(
  db: Db,
  workspaceId: string,
  planId: string,
  learning: Record<string, unknown>
) {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(and(eq(dexterPlans.id, planId), eq(dexterPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) throw new HttpError("Dexter plan not found", 404);

  const outcome = { ...(typeof plan.outcome === "object" && plan.outcome ? plan.outcome : {}), learning };
  const [updated] = await db
    .update(dexterPlans)
    .set({ status: "learned", outcome })
    .where(eq(dexterPlans.id, planId))
    .returning();
  return updated!;
}

export interface LinkedinVoiceEligibilityResult {
  eligible: boolean;
  status: "accepted" | "pending" | "unknown";
  reason?: string;
  prospectName?: string;
  linkedinUrl?: string | null;
}

export interface LinkedinVoiceDraftResult {
  scriptText: string;
  regionalBriefPreview: string;
  estimatedDurationSeconds: number;
  prospect: {
    id: string;
    name: string;
    title?: string;
    company?: string;
  };
}

export interface VoiceSynthesisResult {
  audioBase64: string;
  mimeType: string;
  voice: string;
  durationEstimateSeconds: number;
}

export async function checkLinkedinVoiceEligibility(
  db: Db,
  config: Env,
  opts: {
    workspaceId: string;
    prospectId: string;
    linkedinUrl?: string;
  }
): Promise<LinkedinVoiceEligibilityResult> {
  const prospect = await resolveProspectFields(config, db, opts.workspaceId, opts.prospectId);
  const linkedinUrl = opts.linkedinUrl || prospect?.linkedinUrl;

  if (!linkedinUrl) {
    return {
      eligible: false,
      status: "unknown",
      reason: "missing_linkedin_url",
      prospectName: prospect?.fullName ?? opts.prospectId,
      linkedinUrl: null,
    };
  }

  const status = await checkLinkedinConnectionStatus(config, db, {
    workspaceId: opts.workspaceId,
    prospectId: opts.prospectId,
    linkedinUrl,
  });

  const isEligible = status === "accepted";
  return {
    eligible: isEligible,
    status,
    reason: isEligible ? undefined : "not_first_degree_connection",
    prospectName: prospect?.fullName ?? opts.prospectId,
    linkedinUrl,
  };
}

export async function draftLinkedinVoiceScript(
  db: Db,
  config: Env,
  opts: {
    workspaceId: string;
    prospectId: string;
    goal?: string;
    tone?: string;
    customNotes?: string;
    userId?: string;
  }
): Promise<LinkedinVoiceDraftResult> {
  const prospect = await resolveProspectFields(config, db, opts.workspaceId, opts.prospectId);
  const firstName = prospect?.firstName || "there";
  const fullName = prospect?.fullName || firstName;
  const title = prospect?.title || "Sales/GTM Leader";
  const companyName = prospect?.companyName || "your team";

  // Generate regional briefing context
  const regional = await generateRegionalBrief(
    {
      location: "United States",
      purpose: "onboarding",
      companyIndustry: companyName,
      productDescription: opts.goal ?? "B2B Pipeline & Outbound",
    },
    config.OPENROUTER_API_KEY
  );

  const regionalBriefPreview = `Regional Tone: ${regional.outreachTone} | Cultural Guidance: ${regional.marketNotes.slice(0, 2).join("; ")}`;

  let scriptText = `Hey ${firstName}, hope you're having a productive week at ${companyName}. I noticed your work leading ${title} and wanted to share a quick 30-second idea on how similar teams are accelerating outbound pipeline. Would love to connect and compare notes if you're open to it.`;

  if (config.OPENROUTER_API_KEY || config.OPENAI_API_KEY) {
    try {
      const apiKey = config.OPENROUTER_API_KEY || config.OPENAI_API_KEY;
      const client = new OpenAI({
        apiKey,
        baseURL: config.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : undefined,
      });
      const prompt = `You are Dexter, an expert B2B SDR drafting a 30-second LinkedIn Voice Note script.
Prospect: ${fullName}, ${title} at ${companyName}.
Goal / Offer: ${opts.goal ?? "Explore outbound acceleration and pipeline efficiency"}.
Regional Context & Tone: ${regionalBriefPreview}. ${opts.tone ? `Preferred tone: ${opts.tone}.` : ""}
${opts.customNotes ? `Additional notes: ${opts.customNotes}` : ""}

Rules:
- 50 to 75 words total (natural 30-35 second spoken audio).
- Speak naturally and conversationally, avoid stiff marketing jargon or bullet points.
- Address them by first name (${firstName}).
- Reference their role/company smoothly.
- Include a casual, low-friction call to action.
- Return ONLY the plain text spoken script.`;

      const res = await client.chat.completions.create({
        model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
        temperature: 0.7,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });
      const aiScript = res.choices[0]?.message?.content?.trim();
      if (aiScript && aiScript.length > 20) {
        scriptText = aiScript;
      }
    } catch (err) {
      log.warn("dexter-journey: AI script draft fallback used", { err });
    }
  }

  const wordCount = scriptText.split(/\s+/).length;
  const estimatedDurationSeconds = Math.max(20, Math.round(wordCount / 2.5));

  return {
    scriptText,
    regionalBriefPreview,
    estimatedDurationSeconds,
    prospect: {
      id: opts.prospectId,
      name: fullName,
      title: prospect?.title,
      company: prospect?.companyName,
    },
  };
}

export async function synthesizeVoiceAudio(
  config: Env,
  opts: {
    scriptText: string;
    voice?: string;
  }
): Promise<VoiceSynthesisResult> {
  const voice = opts.voice ?? "alloy";
  const scriptText = opts.scriptText.trim();
  if (!scriptText) {
    throw new HttpError("scriptText is required for voice synthesis", 400);
  }

  if (config.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      if (openai.audio?.speech) {
        const mp3 = await openai.audio.speech.create({
          model: "tts-1",
          voice: (["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voice) ? voice : "alloy") as "alloy",
          input: scriptText.slice(0, 4096),
        });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        const audioBase64 = buffer.toString("base64");
        const wordCount = scriptText.split(/\s+/).length;
        const durationEstimateSeconds = Math.max(5, Math.round(wordCount / 2.5));
        return {
          audioBase64,
          mimeType: "audio/mpeg",
          voice,
          durationEstimateSeconds,
        };
      }
    } catch (err) {
      log.warn("dexter-journey: OpenAI TTS synthesis failed, providing audio preview", { err });
    }
  }

  // Deterministic valid MP3 frame base64 preview for dev/test environments
  const mockMp3Base64 =
    "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABhAADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw==";
  const wordCount = scriptText.split(/\s+/).length;
  const durationEstimateSeconds = Math.max(5, Math.round(wordCount / 2.5));

  return {
    audioBase64: mockMp3Base64,
    mimeType: "audio/mpeg",
    voice,
    durationEstimateSeconds,
  };
}

export async function createLinkedinVoiceHandoff(
  db: Db,
  config: Env,
  opts: {
    workspaceId: string;
    prospectId: string;
    scriptText: string;
    voiceChoice?: string;
    regionalBriefPreview?: string;
    userId?: string;
    bypassEligibilityCheck?: boolean;
  }
) {
  if (!opts.bypassEligibilityCheck) {
    const eligibility = await checkLinkedinVoiceEligibility(db, config, {
      workspaceId: opts.workspaceId,
      prospectId: opts.prospectId,
    });
    if (!eligibility.eligible && eligibility.status === "pending") {
      throw new HttpError(
        "Prospect must be a 1st-degree LinkedIn connection before creating a voice handoff",
        422
      );
    }
  }

  let evidenceId: string | undefined;
  try {
    const pinned = await pinAiClaim(db, {
      workspaceId: opts.workspaceId,
      entityType: "prospect",
      entityId: opts.prospectId,
      attribute: "linkedin_voice_script",
      value: { scriptPreview: opts.scriptText.slice(0, 500), voiceChoice: opts.voiceChoice ?? "self" },
      source: "linkedin_voice",
      method: "linkedin_voice_script",
      versionName: "personalize",
    });
    evidenceId = pinned.evidenceId;
  } catch {
    // Pin failure must not block handoff preview.
  }

  const token = randomUUID();
  const [row] = await db
    .insert(linkedinVoiceHandoffs)
    .values({
      workspaceId: opts.workspaceId,
      prospectId: opts.prospectId,
      scriptText: opts.scriptText,
      voiceChoice: opts.voiceChoice ?? "self",
      regionalBriefPreview: opts.regionalBriefPreview,
      evidenceId,
      status: "handed_off",
      handoffToken: token,
      createdBy: opts.userId,
    })
    .returning();

  return row!;
}

export async function confirmLinkedinVoiceSent(
  db: Db,
  opts: { workspaceId: string; handoffToken: string; userId?: string }
) {
  const [handoff] = await db
    .select()
    .from(linkedinVoiceHandoffs)
    .where(
      and(
        eq(linkedinVoiceHandoffs.handoffToken, opts.handoffToken),
        eq(linkedinVoiceHandoffs.workspaceId, opts.workspaceId)
      )
    )
    .limit(1);
  if (!handoff) throw new HttpError("Handoff not found", 404);
  if (handoff.status === "confirmed") return handoff;

  await assertAllowed(db, {
    workspaceId: opts.workspaceId,
    actionKey: "linkedin.voice_confirm",
    actorUserId: opts.userId,
    entityType: "linkedin_voice_handoff",
    entityId: handoff.id,
    priorApproval: true,
  });

  // Timeline activity (CRM shared table) — manual confirm only, never background send.
  try {
    await db.insert(activities).values({
      workspaceId: opts.workspaceId,
      entityType: "prospect",
      entityId: randomUUID(),
      activityType: "linkedin_voice_sent",
      subject: "LinkedIn voice message confirmed",
      body: `${handoff.scriptText.slice(0, 1800)}\n\nprospectId=${handoff.prospectId};handoffId=${handoff.id}`,
      ownerId: opts.userId,
      occurredAt: new Date(),
    });
  } catch {
    // activities insert is best-effort for timeline capture.
  }

  const [updated] = await db
    .update(linkedinVoiceHandoffs)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(eq(linkedinVoiceHandoffs.id, handoff.id))
    .returning();

  incrJourneyMetric("linkedinVoiceConfirm");
  return updated!;
}

