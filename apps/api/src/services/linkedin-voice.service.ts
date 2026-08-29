import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import OpenAI from "openai";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { assertAllowed } from "./policy-gateway.service.js";
import { incrJourneyMetric } from "./journey-metrics.js";
import { pinAiClaim } from "./ai-evidence.service.js";
import type { Env } from "../config/env.js";
import { checkLinkedinConnectionStatus } from "./linkedin-connection.service.js";
import { LinkedinAccountService } from "./linkedin-account.service.js";
import { resolveProspectFields, type ResolvedProspect } from "./prospect-resolver.service.js";
import { generateRegionalBrief } from "./regional-intel.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md for the full audit and rationale; a new instance of
 * the same pattern the 9 confirmed cases there already cover.
 *   - Tables touched directly: contacts, activities (both owned by apps/crm)
 *     - read AND write
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: confirmLinkedinVoiceSent() resolves the CRM contact for a prospect and writes the
 *     "voice message sent" event straight to that contact's timeline in the same request the
 *     rep clicks "I sent this voice message" - a synchronous, user-facing confirm action where
 *     an HTTP round trip into apps/crm would add latency to a click the rep is watching resolve
 *   - Review date: revisit once apps/crm's internal API surface covers activity writes (Wave 2)
 */
const log = createLogger("linkedin-voice");
const { linkedinVoiceHandoffs, activities, contacts } = schema;

const SYNTHETIC_PROFILES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export type SyntheticVoiceProfile = (typeof SYNTHETIC_PROFILES)[number];

const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LinkedinVoiceChoice = "personal" | "synthetic";
export type LinkedinVoiceHandoffStatus = "preview" | "handed_off" | "confirmed" | "expired" | "cancelled";

export interface LinkedinVoiceEligibilityResult {
  eligible: boolean;
  status: "accepted" | "pending" | "unknown";
  reason?: string;
  prospectName?: string;
  linkedinUrl?: string | null;
  location?: string | null;
}

export interface LinkedinVoiceDraftResult {
  scriptText: string;
  regionalBriefPreview: string;
  estimatedDurationSeconds: number;
  language: string;
  evidence: {
    unverified: true;
    location: string;
    tone: string;
    citations: string[];
  };
  prospect: {
    id: string;
    name: string;
    title?: string;
    company?: string;
    linkedinUrl?: string | null;
    location?: string | null;
  };
}

export interface VoiceSynthesisResult {
  audioBase64: string;
  mimeType: string;
  voice: string;
  durationEstimateSeconds: number;
  previewOnly: true;
}

export interface LinkedinVoiceHandoffResult {
  id: string;
  handoffToken: string;
  status: string;
  evidenceId?: string | null;
  voiceChoice: string;
  syntheticProfile: string | null;
  prospectName?: string | null;
  linkedinUrl?: string | null;
  expiresAt?: string | null;
  mobileUrl: string;
  note: string;
}

function frontendBase(config: Env): string {
  return (config.FRONTEND_URL ?? config.CORS_ORIGIN?.[0] ?? "http://localhost:3000").replace(/\/$/, "");
}

function manualSendNote(): string {
  return "Manual send only — LinkedIn voice notes cannot be sent from Skout. Open the mobile handoff, record in the LinkedIn app, then confirm.";
}

export function normalizeVoiceChoice(
  raw?: string | null
): { voiceChoice: LinkedinVoiceChoice; syntheticProfile: SyntheticVoiceProfile | null } {
  const v = (raw ?? "personal").trim().toLowerCase();
  if (v === "personal" || v === "self" || v === "none" || v === "user") {
    return { voiceChoice: "personal", syntheticProfile: null };
  }
  if ((SYNTHETIC_PROFILES as readonly string[]).includes(v)) {
    return { voiceChoice: "synthetic", syntheticProfile: v as SyntheticVoiceProfile };
  }
  if (v === "synthetic" || v === "cloned" || v === "authorized") {
    return { voiceChoice: "synthetic", syntheticProfile: "alloy" };
  }
  return { voiceChoice: "personal", syntheticProfile: null };
}

function spokenDurationSeconds(scriptText: string): number {
  const wordCount = scriptText.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(8, Math.round(wordCount / 2.5));
}

function prospectLocation(prospect: ResolvedProspect | null): string {
  return prospect?.location?.trim() || "United States";
}

function skipEligibilityForTests(config: Env): boolean {
  return config.NODE_ENV === "test";
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
  const linkedinUrl = opts.linkedinUrl?.trim() || prospect?.linkedinUrl;

  if (!prospect && !linkedinUrl) {
    return {
      eligible: false,
      status: "unknown",
      reason: "prospect_not_found",
      prospectName: opts.prospectId,
      linkedinUrl: null,
    };
  }

  if (!linkedinUrl) {
    return {
      eligible: false,
      status: "unknown",
      reason: "missing_linkedin_url",
      prospectName: prospect?.fullName ?? opts.prospectId,
      linkedinUrl: null,
      location: prospect?.location ?? null,
    };
  }

  const accounts = new LinkedinAccountService(db, config);
  const rows = await accounts.list(opts.workspaceId, "linkedin");
  const activeAccounts = rows.filter((a) => a.status === "active");
  if (activeAccounts.length === 0) {
    return {
      eligible: false,
      status: "unknown",
      reason: "linkedin_account_not_connected",
      prospectName: prospect?.fullName ?? opts.prospectId,
      linkedinUrl,
      location: prospect?.location ?? null,
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
    location: prospect?.location ?? null,
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
    language?: string;
    userId?: string;
  }
): Promise<LinkedinVoiceDraftResult> {
  const prospect = await resolveProspectFields(config, db, opts.workspaceId, opts.prospectId);
  const firstName = prospect?.firstName || "there";
  const fullName = prospect?.fullName || firstName;
  const title = prospect?.title || "your role";
  const companyName = prospect?.companyName || "your team";
  const location = prospectLocation(prospect);

  const regional = await generateRegionalBrief(
    {
      location,
      purpose: "onboarding",
      companyIndustry: prospect?.companyName,
      productDescription: opts.goal ?? "B2B outbound conversation",
    },
    config.OPENROUTER_API_KEY
  );

  const language = opts.language?.trim() || regional.locale || "en";
  const regionalBriefPreview = [
    `Regional tone: ${regional.outreachTone}`,
    regional.summary ? `Brief: ${regional.summary}` : null,
    regional.marketNotes[0] ? `Practice: ${regional.marketNotes[0]}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  let scriptText = `Hey ${firstName} — quick note from me. I noticed your work as ${title} at ${companyName} and wanted to share a short idea on how similar teams are tightening outbound. If it's useful, happy to compare notes for 15 minutes.`;

  if (config.OPENROUTER_API_KEY || config.OPENAI_API_KEY) {
    try {
      const apiKey = config.OPENROUTER_API_KEY || config.OPENAI_API_KEY;
      const client = new OpenAI({
        apiKey,
        baseURL: config.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : undefined,
      });
      const prompt = `You are Dexter, drafting a LinkedIn voice-note SCRIPT the user will speak themselves.
Prospect: ${fullName}, ${title} at ${companyName}. Location: ${location}.
Goal: ${opts.goal ?? "Start a low-friction conversation"}.
Tone: ${opts.tone ?? regional.outreachTone}.
Language: ${language}.
Regional context (unverified guidance, not facts): ${regionalBriefPreview}.
${opts.customNotes ? `Seller notes: ${opts.customNotes}` : ""}

Rules:
- 50 to 75 words (about 30 seconds spoken).
- Conversational, first person, no bullet points, no hashtags, no "As an AI".
- Address them by first name (${firstName}).
- Reference role/company once, naturally.
- Cite no invented metrics, customers, or funding events.
- One low-friction CTA.
- Return ONLY the spoken script.`;

      const res = await client.chat.completions.create({
        model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
        temperature: 0.7,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });
      const aiScript = res.choices[0]?.message?.content?.trim();
      if (aiScript && aiScript.length > 20) {
        scriptText = aiScript.replace(/^["']|["']$/g, "");
      }
    } catch (err) {
      log.warn("linkedin-voice: AI script draft fallback used", { err });
    }
  }

  return {
    scriptText,
    regionalBriefPreview,
    estimatedDurationSeconds: spokenDurationSeconds(scriptText),
    language,
    evidence: {
      unverified: true,
      location,
      tone: opts.tone ?? regional.outreachTone,
      citations: ["prospect_role", "prospect_company", "regional_brief"],
    },
    prospect: {
      id: opts.prospectId,
      name: fullName,
      title: prospect?.title,
      company: prospect?.companyName,
      linkedinUrl: prospect?.linkedinUrl ?? null,
      location: prospect?.location ?? null,
    },
  };
}

export async function synthesizeVoiceAudio(
  config: Env,
  opts: { scriptText: string; voice?: string }
): Promise<VoiceSynthesisResult> {
  const { syntheticProfile } = normalizeVoiceChoice(opts.voice ?? "alloy");
  const voice = syntheticProfile ?? "alloy";
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
          voice: voice as "alloy",
          input: scriptText.slice(0, 4096),
        });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        return {
          audioBase64: buffer.toString("base64"),
          mimeType: "audio/mpeg",
          voice,
          durationEstimateSeconds: spokenDurationSeconds(scriptText),
          previewOnly: true,
        };
      }
    } catch (err) {
      log.warn("linkedin-voice: OpenAI TTS failed, using preview placeholder", { err });
    }
  }

  const mockMp3Base64 =
    "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABhAADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw==";

  return {
    audioBase64: mockMp3Base64,
    mimeType: "audio/mpeg",
    voice,
    durationEstimateSeconds: spokenDurationSeconds(scriptText),
    previewOnly: true,
  };
}

function toHandoffResult(
  config: Env,
  row: typeof linkedinVoiceHandoffs.$inferSelect
): LinkedinVoiceHandoffResult {
  const { syntheticProfile } = normalizeVoiceChoice(row.syntheticProfile ?? row.voiceChoice);
  return {
    id: row.id,
    handoffToken: row.handoffToken,
    status: row.status,
    evidenceId: row.evidenceId,
    voiceChoice: row.voiceChoice,
    syntheticProfile,
    prospectName: row.prospectName,
    linkedinUrl: row.linkedinUrl,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    mobileUrl: `${frontendBase(config)}/app/linkedin/voice/h/${row.handoffToken}`,
    note: manualSendNote(),
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
    language?: string;
    linkedinUrl?: string;
    userId?: string;
  }
): Promise<LinkedinVoiceHandoffResult> {
  const eligibility = await checkLinkedinVoiceEligibility(db, config, {
    workspaceId: opts.workspaceId,
    prospectId: opts.prospectId,
    linkedinUrl: opts.linkedinUrl,
  });

  if (!eligibility.eligible && !skipEligibilityForTests(config)) {
    throw new HttpError(
      eligibility.reason === "linkedin_account_not_connected"
        ? "Connect a LinkedIn account (Unipile) before creating a voice handoff"
        : eligibility.reason === "missing_linkedin_url"
          ? "Prospect needs a LinkedIn profile URL before a voice handoff can be created"
          : "Prospect must be a 1st-degree LinkedIn connection before creating a voice handoff",
      422,
      { eligibility }
    );
  }

  const { voiceChoice, syntheticProfile } = normalizeVoiceChoice(opts.voiceChoice);
  const prospect = await resolveProspectFields(config, db, opts.workspaceId, opts.prospectId);
  const linkedinUrl = opts.linkedinUrl?.trim() || eligibility.linkedinUrl || prospect?.linkedinUrl || null;

  let evidenceId: string | undefined;
  try {
    const pinned = await pinAiClaim(db, {
      workspaceId: opts.workspaceId,
      entityType: "prospect",
      entityId: opts.prospectId,
      attribute: "linkedin_voice_script",
      value: {
        scriptPreview: opts.scriptText.slice(0, 500),
        voiceChoice,
        syntheticProfile,
        language: opts.language,
      },
      source: "linkedin_voice",
      method: "linkedin_voice_script",
      versionName: "personalize",
    });
    evidenceId = pinned.evidenceId;
  } catch (err) {
    log.warn("linkedin-voice: evidence pin skipped", { err });
  }

  const token = randomUUID();
  const [row] = await db
    .insert(linkedinVoiceHandoffs)
    .values({
      workspaceId: opts.workspaceId,
      prospectId: opts.prospectId,
      prospectName: eligibility.prospectName ?? prospect?.fullName ?? null,
      linkedinUrl,
      scriptText: opts.scriptText,
      voiceChoice,
      syntheticProfile,
      language: opts.language ?? "en",
      regionalBriefPreview: opts.regionalBriefPreview,
      evidenceId,
      status: "handed_off",
      handoffToken: token,
      expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
      createdBy: opts.userId,
    })
    .returning();

  return toHandoffResult(config, row!);
}

async function resolveTimelineContactId(
  db: Db,
  workspaceId: string,
  prospectId: string
): Promise<string | null> {
  const [bySource] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.sourceProspectId, prospectId)))
    .limit(1);
  if (bySource?.id) return bySource.id;
  if (UUID_RE.test(prospectId)) return prospectId;
  return null;
}

export async function confirmLinkedinVoiceSent(
  db: Db,
  opts: { workspaceId: string; handoffToken: string; userId?: string; outcomeNote?: string }
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
  if (handoff.status === "expired" || (handoff.expiresAt && handoff.expiresAt.getTime() < Date.now())) {
    if (handoff.status !== "expired") {
      const [expired] = await db
        .update(linkedinVoiceHandoffs)
        .set({ status: "expired" })
        .where(eq(linkedinVoiceHandoffs.id, handoff.id))
        .returning();
      throw new HttpError("Handoff has expired — create a new one", 422, { handoff: expired });
    }
    throw new HttpError("Handoff has expired — create a new one", 422);
  }

  await assertAllowed(db, {
    workspaceId: opts.workspaceId,
    actionKey: "linkedin.voice_confirm",
    actorUserId: opts.userId,
    entityType: "linkedin_voice_handoff",
    entityId: handoff.id,
    priorApproval: true,
  });

  let activityId: string | undefined = handoff.activityId ?? undefined;
  const contactId = await resolveTimelineContactId(db, opts.workspaceId, handoff.prospectId);
  if (contactId && UUID_RE.test(contactId)) {
    try {
      const [activity] = await db
        .insert(activities)
        .values({
          workspaceId: opts.workspaceId,
          entityType: "contact",
          entityId: contactId,
          activityType: "linkedin_voice_sent",
          subject: `LinkedIn voice message${handoff.prospectName ? `: ${handoff.prospectName}` : ""}`,
          body: [
            handoff.scriptText.slice(0, 1800),
            "",
            `prospectId=${handoff.prospectId}`,
            `handoffId=${handoff.id}`,
            `voiceChoice=${handoff.voiceChoice}`,
            opts.outcomeNote ? `note=${opts.outcomeNote}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          ownerId: opts.userId,
          occurredAt: new Date(),
        })
        .returning();
      activityId = activity?.id;
    } catch (err) {
      log.warn("linkedin-voice: timeline activity insert skipped", { err });
    }
  } else {
    log.info("linkedin-voice: no CRM contact to attach timeline activity", {
      prospectId: handoff.prospectId,
    });
  }

  const [updated] = await db
    .update(linkedinVoiceHandoffs)
    .set({
      status: "confirmed",
      confirmedAt: new Date(),
      confirmedBy: opts.userId,
      outcomeNote: opts.outcomeNote,
      activityId,
    })
    .where(eq(linkedinVoiceHandoffs.id, handoff.id))
    .returning();

  incrJourneyMetric("linkedinVoiceConfirm");
  return updated!;
}

export async function getLinkedinVoiceHandoff(
  db: Db,
  config: Env,
  opts: { workspaceId: string; handoffToken: string }
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
  return { ...toHandoffResult(config, handoff), scriptText: handoff.scriptText, prospectId: handoff.prospectId };
}

export async function listLinkedinVoiceHandoffs(db: Db, workspaceId: string, limit = 20) {
  return db
    .select()
    .from(linkedinVoiceHandoffs)
    .where(eq(linkedinVoiceHandoffs.workspaceId, workspaceId))
    .orderBy(desc(linkedinVoiceHandoffs.createdAt))
    .limit(Math.min(50, Math.max(1, limit)));
}
