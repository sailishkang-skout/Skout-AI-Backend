import { OpenAI } from "openai";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { listSignalsForEntity } from "./signal.service.js";
import { recordEvidence } from "./evidence.service.js";
import { parseNextBestActionResponse } from "./intelligence-layer.service.js";

const log = createLogger("next-best-action.service");
const {
  contacts,
  companies,
  deals,
  activities,
  tasks,
  meetings,
  prospectActivations,
  prospectScores,
  nextBestActionSuggestions,
} = schema;

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md for the full audit and rationale; one of the 9
 * confirmed instances listed there (formalized in Task 17).
 *   - Tables touched directly: contacts, deals, companies, activities, tasks (all owned by
 *     apps/crm) - read only
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: gatherContext() assembles a compact cross-entity history summary in one pass to
 *     feed the LLM prompt synchronously; splitting this into per-table HTTP calls into apps/crm
 *     would add latency directly felt by the user waiting on a suggestion and complicate a
 *     read that's naturally one query set
 *   - Review date: revisit once apps/crm's internal API surface exists (Wave 2)
 */

/**
 * §5.3 — the model doesn't emit its own calibrated confidence for a suggestion, so the
 * evidence-ledger dual-write below uses this fixed default. Deliberately mid-range: useful as
 * evidence, but should still be outranked by a manually-entered or corroborated fact.
 */
const NEXT_BEST_ACTION_MODEL_CONFIDENCE = 0.65;

export type SuggestedActionType = "call" | "email" | "meeting" | "wait" | "task";

export interface NextBestActionSuggestion {
  actionType: SuggestedActionType;
  headline: string;
  rationale: string;
  draftMessage?: string;
}

const SYSTEM_PROMPT = `You are a sales-ops assistant suggesting the single best next action for a
GTM rep to take on one CRM contact or deal, based on the recent activity/task/meeting history,
AND the prospect's ICP score and any active signals (funding, hiring, intent spikes, etc.) when
given. Weigh score/signals as real inputs, not decoration — e.g. a high score plus an active
hiring signal should push toward a more assertive next step than the same activity history alone
would. Be specific and concrete, not generic. Reply with ONLY valid JSON (no markdown fences):
{
  "actionType": "call" | "email" | "meeting" | "wait" | "task",
  "headline": "one short sentence — the action itself, e.g. 'Call about the paused pilot'",
  "rationale": "1-2 sentences on why, grounded in the specific history and score/signals given",
  "draftMessage": "optional — a short draft if actionType is email, otherwise omit"
}
If there's genuinely nothing to act on yet (no signal either way), use actionType "wait" and say so.`;

/** R20.3 — gather compact recent-history context for one contact or deal. */
async function gatherContext(
  db: Db,
  workspaceId: string,
  entityType: "contact" | "deal",
  entityId: string
): Promise<{ label: string; contactId: string | null; companyId: string | null; contextText: string } | null> {
  let label = "";
  let contactId: string | null = null;
  let companyId: string | null = null;
  const lines: string[] = [];

  if (entityType === "contact") {
    const [contact] = await db.select().from(contacts).where(scopedById(contacts, workspaceId, entityId)).limit(1);
    if (!contact) return null;
    contactId = contact.id;
    companyId = contact.companyId;
    label = `${contact.firstName} ${contact.lastName ?? ""}`.trim();
    lines.push(`Contact: ${label}, title: ${contact.title ?? "unknown"}, lifecycle stage: ${contact.lifecycleStage}`);
  } else {
    const [deal] = await db.select().from(deals).where(scopedById(deals, workspaceId, entityId)).limit(1);
    if (!deal) return null;
    companyId = deal.companyId;
    label = deal.name;
    lines.push(`Deal: ${deal.name}, status: ${deal.status}, amount: ${deal.amount ?? "unknown"} ${deal.currency ?? ""}`);
  }

  if (companyId) {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    if (company) lines.push(`Company: ${company.name}${company.industry ? `, industry: ${company.industry}` : ""}`);
  }

  const recentActivities = await db
    .select()
    .from(activities)
    .where(scopedTo(activities, workspaceId, eq(activities.entityType, entityType), eq(activities.entityId, entityId)))
    .orderBy(desc(activities.occurredAt))
    .limit(5);
  if (recentActivities.length) {
    lines.push("Recent activity (most recent first):");
    for (const a of recentActivities) {
      lines.push(`- [${a.occurredAt.toISOString().slice(0, 10)}] ${a.activityType}${a.subject ? `: ${a.subject}` : ""}`);
    }
  } else {
    lines.push("No logged activity yet.");
  }

  const openTasks = await db
    .select()
    .from(tasks)
    .where(scopedTo(tasks, workspaceId, eq(tasks.relatedEntityType, entityType), eq(tasks.relatedEntityId, entityId), eq(tasks.status, "open")))
    .limit(5);
  if (openTasks.length) {
    lines.push("Open tasks:");
    for (const t of openTasks) lines.push(`- ${t.title} (due ${t.dueDate ? t.dueDate.toISOString().slice(0, 10) : "no date"})`);
  }

  if (contactId) {
    const recentMeeting = await db
      .select()
      .from(meetings)
      .where(scopedTo(meetings, workspaceId, eq(meetings.contactId, contactId)))
      .orderBy(desc(meetings.scheduledAt))
      .limit(1);
    const meeting = recentMeeting[0];
    if (meeting) {
      lines.push(
        `Most recent meeting (${meeting.scheduledAt.toISOString().slice(0, 10)}): outcome=${meeting.outcome ?? "not set"}${meeting.summary ? `, summary: ${meeting.summary.slice(0, 500)}` : ""}`
      );
    }
  }

  // R20.3 AC — ground the suggestion in the prospect's actual score/signals, not just activity
  // history. Only reachable when the CRM record is linked back to a corpus prospect (contact's
  // `sourceProspectId`, or a deal's company `sourceProspectCompanyId` for a signal-only read).
  let sourceProspectId: string | null = null;
  if (contactId) {
    const [contact] = await db.select({ sourceProspectId: contacts.sourceProspectId }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
    sourceProspectId = contact?.sourceProspectId ?? null;
  }
  if (sourceProspectId) {
    const [scoreRow] = await db
      .select()
      .from(prospectActivations)
      .where(scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, sourceProspectId)))
      .limit(1);
    const [score] = await db
      .select()
      .from(prospectScores)
      .where(scopedTo(prospectScores, workspaceId, eq(prospectScores.prospectId, sourceProspectId)))
      .limit(1);
    if (score) {
      lines.push(`ICP score: ${score.score}/100${score.priority ? ` (priority: ${score.priority})` : ""}`);
    } else if (scoreRow) {
      lines.push(`Activated prospect, not yet scored.`);
    }

    const signalRecords = await listSignalsForEntity(db, sourceProspectId, { entityType: "prospect" });
    if (signalRecords.length > 0) {
      const types = [...new Set(signalRecords.map((s) => s.signalType))];
      lines.push(`Active signals: ${types.join(", ")}`);
    }
  }

  return { label, contactId, companyId, contextText: lines.join("\n") };
}

export async function suggestNextBestAction(
  db: Db,
  config: Env,
  workspaceId: string,
  entityType: "contact" | "deal",
  entityId: string
): Promise<{ label: string; suggestion: NextBestActionSuggestion } | null> {
  const ctx = await gatherContext(db, workspaceId, entityType, entityId);
  if (!ctx) return null;

  if (!config.OPENROUTER_API_KEY) {
    // No fallback fabrication — be honest that this needs a configured LLM key.
    throw Object.assign(new Error("OpenRouter API key is not configured — set OPENROUTER_API_KEY"), { statusCode: 503 });
  }

  const client = new OpenAI({
    apiKey: config.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });

  let raw: string;
  try {
    const result = await client.chat.completions.create({
      model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
      max_tokens: 400,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: ctx.contextText },
      ],
    });
    raw = result.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    log.error("next-best-action LLM call failed", { err });
    throw Object.assign(new Error("AI suggestion failed"), { statusCode: 502 });
  }

  // §6.0 — response parsing/validation now lives in intelligence-layer.service.ts's
  // parseNextBestActionResponse (step 6 of the shared pipeline); this function is a thin
  // wrapper handling the LLM call itself, which the shared layer deliberately stays free of.
  const parsedSuggestion = parseNextBestActionResponse(raw, ["call", "email", "meeting", "wait", "task"]);

  return {
    label: ctx.label,
    suggestion: {
      actionType: parsedSuggestion.actionType as SuggestedActionType,
      headline: parsedSuggestion.headline,
      rationale: parsedSuggestion.rationale,
      draftMessage: parsedSuggestion.draftMessage,
    },
  };
}

/**
 * R20.3 — persists every suggestion generated (accepted or not), so acceptance rate is a real,
 * queryable number instead of something only visible in a chat transcript.
 *
 * §6.1 anti-hallucination contract — unlike most Evidence Ledger dual-writes elsewhere in this
 * codebase (which are best-effort provenance bookkeeping on data that's already trusted, e.g.
 * a manual CRM edit), a next-best-action suggestion IS the AI-generated claim itself. The
 * contract's own doc comment is explicit that `unverified` may never be used for an
 * AI-generated claim, so a failed evidence-ledger write here can't be silently swallowed the
 * way it is for autoFill/identity-merge dual-writes — it has to fail the request, which is
 * exactly what "enforced at the API-response-schema level so a claim without one fails
 * validation rather than shipping silently" (§6.1's own completion criteria) asks for.
 */
export async function recordSuggestion(
  db: Db,
  workspaceId: string,
  entityType: "contact" | "deal",
  entityId: string,
  createdBy: string | undefined,
  suggestion: NextBestActionSuggestion
): Promise<{ suggestionId: string; evidenceId: string }> {
  const [row] = await db
    .insert(nextBestActionSuggestions)
    .values({
      workspaceId,
      entityType,
      entityId,
      actionType: suggestion.actionType,
      headline: suggestion.headline,
      rationale: suggestion.rationale,
      draftMessage: suggestion.draftMessage,
      createdBy,
    })
    .returning({ id: nextBestActionSuggestions.id });

  // §5.3 / §6.1 — write into the canonical Evidence Ledger so "why did we suggest this" is
  // queryable, AND so the claim returned to the API caller has a real evidence_id to cite
  // (see the doc comment above for why this one call site does NOT swallow the failure).
  let evidenceRow: { id: string } | undefined;
  try {
    evidenceRow = await recordEvidence(db, {
      workspaceId,
      entityType,
      entityId,
      attribute: "next_best_action",
      value: {
        suggestionId: row!.id,
        actionType: suggestion.actionType,
        headline: suggestion.headline,
        rationale: suggestion.rationale,
        draftMessage: suggestion.draftMessage,
      },
      source: "next_best_action_model",
      observedAt: new Date(),
      confidence: NEXT_BEST_ACTION_MODEL_CONFIDENCE,
      method: "llm_suggestion",
    });
  } catch (err) {
    log.error("evidence ledger write failed for next-best-action suggestion — failing the request per §6.1 (no ungrounded AI claim ships)", {
      err,
      suggestionId: row!.id,
    });
    throw Object.assign(new Error("Could not record evidence for this suggestion — not returning an unverified AI claim"), {
      statusCode: 502,
    });
  }

  return { suggestionId: row!.id, evidenceId: evidenceRow.id };
}

export type SuggestionAcceptedAction = "create_task" | "enroll_sequence";

/** Marks a suggestion as acted on. Idempotent-ish: re-accepting just overwrites the prior accept record. */
export async function markSuggestionAccepted(
  db: Db,
  workspaceId: string,
  suggestionId: string,
  acceptedAction: SuggestionAcceptedAction,
  acceptedRefId: string
): Promise<boolean> {
  const [row] = await db
    .update(nextBestActionSuggestions)
    .set({ acceptedAt: new Date(), acceptedAction, acceptedRefId })
    .where(scopedById(nextBestActionSuggestions, workspaceId, suggestionId))
    .returning({
      id: nextBestActionSuggestions.id,
      entityType: nextBestActionSuggestions.entityType,
      entityId: nextBestActionSuggestions.entityId,
    });
  if (!row) return false;

  // §5.3 — a human accepting a suggestion is itself a fact worth recording: confidence 1.0
  // because it's a direct user action, not a model inference. Best-effort, same as above.
  try {
    await recordEvidence(db, {
      workspaceId,
      entityType: row.entityType,
      entityId: row.entityId,
      attribute: "next_best_action_accepted",
      value: { suggestionId: row.id, acceptedAction, acceptedRefId },
      source: "user_action",
      observedAt: new Date(),
      confidence: 1,
      method: "suggestion_accept",
    });
  } catch (err) {
    log.error("evidence ledger dual-write failed for next-best-action acceptance", { err, suggestionId: row.id });
  }

  return true;
}

/** R20.3 — acceptance-rate readout. Prefers evidence_ledger; falls back to NBA table for history. */
export async function getSuggestionStats(
  db: Db,
  workspaceId: string
): Promise<{ total: number; accepted: number; acceptanceRate: number; source: "evidence_ledger" | "nba_table" }> {
  const { evidenceLedger } = schema;

  const totalLedger = await db
    .select({ id: evidenceLedger.id })
    .from(evidenceLedger)
    .where(scopedTo(evidenceLedger, workspaceId, eq(evidenceLedger.attribute, "next_best_action")));

  const acceptedLedger = await db
    .select({ id: evidenceLedger.id })
    .from(evidenceLedger)
    .where(scopedTo(evidenceLedger, workspaceId, eq(evidenceLedger.attribute, "next_best_action_accepted")));

  if (totalLedger.length > 0 || acceptedLedger.length > 0) {
    const total = totalLedger.length;
    const accepted = acceptedLedger.length;
    return {
      total,
      accepted,
      acceptanceRate: total > 0 ? accepted / total : 0,
      source: "evidence_ledger",
    };
  }

  // Historical fallback when ledger has no NBA rows yet
  const rows = await db
    .select({ acceptedAt: nextBestActionSuggestions.acceptedAt })
    .from(nextBestActionSuggestions)
    .where(scopedTo(nextBestActionSuggestions, workspaceId));
  const total = rows.length;
  const accepted = rows.filter((r) => r.acceptedAt !== null).length;
  return { total, accepted, acceptanceRate: total > 0 ? accepted / total : 0, source: "nba_table" };
}
