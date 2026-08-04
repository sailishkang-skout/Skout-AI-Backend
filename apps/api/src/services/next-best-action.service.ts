import { OpenAI } from "openai";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";

const log = createLogger("next-best-action.service");
const { contacts, companies, deals, activities, tasks, meetings } = schema;

export type SuggestedActionType = "call" | "email" | "meeting" | "wait" | "task";

export interface NextBestActionSuggestion {
  actionType: SuggestedActionType;
  headline: string;
  rationale: string;
  draftMessage?: string;
}

const SYSTEM_PROMPT = `You are a sales-ops assistant suggesting the single best next action for a
GTM rep to take on one CRM contact or deal, based on the recent activity/task/meeting history
provided. Be specific and concrete, not generic. Reply with ONLY valid JSON (no markdown fences):
{
  "actionType": "call" | "email" | "meeting" | "wait" | "task",
  "headline": "one short sentence — the action itself, e.g. 'Call about the paused pilot'",
  "rationale": "1-2 sentences on why, grounded in the specific history given",
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
    const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, entityId), eq(contacts.workspaceId, workspaceId))).limit(1);
    if (!contact) return null;
    contactId = contact.id;
    companyId = contact.companyId;
    label = `${contact.firstName} ${contact.lastName ?? ""}`.trim();
    lines.push(`Contact: ${label}, title: ${contact.title ?? "unknown"}, lifecycle stage: ${contact.lifecycleStage}`);
  } else {
    const [deal] = await db.select().from(deals).where(and(eq(deals.id, entityId), eq(deals.workspaceId, workspaceId))).limit(1);
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
    .where(and(eq(activities.workspaceId, workspaceId), eq(activities.entityType, entityType), eq(activities.entityId, entityId)))
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
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.relatedEntityType, entityType), eq(tasks.relatedEntityId, entityId), eq(tasks.status, "open")))
    .limit(5);
  if (openTasks.length) {
    lines.push("Open tasks:");
    for (const t of openTasks) lines.push(`- ${t.title} (due ${t.dueDate ? t.dueDate.toISOString().slice(0, 10) : "no date"})`);
  }

  if (contactId) {
    const recentMeeting = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.workspaceId, workspaceId), eq(meetings.contactId, contactId)))
      .orderBy(desc(meetings.scheduledAt))
      .limit(1);
    const meeting = recentMeeting[0];
    if (meeting) {
      lines.push(
        `Most recent meeting (${meeting.scheduledAt.toISOString().slice(0, 10)}): outcome=${meeting.outcome ?? "not set"}${meeting.summary ? `, summary: ${meeting.summary.slice(0, 500)}` : ""}`
      );
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

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { actionType: "wait", headline: "Could not parse a suggestion", rationale: raw.slice(0, 300) };
  }

  const actionType: SuggestedActionType = (["call", "email", "meeting", "wait", "task"] as const).includes(
    parsed.actionType as SuggestedActionType
  )
    ? (parsed.actionType as SuggestedActionType)
    : "wait";

  return {
    label: ctx.label,
    suggestion: {
      actionType,
      headline: typeof parsed.headline === "string" ? parsed.headline : "Review this record",
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      draftMessage: typeof parsed.draftMessage === "string" ? parsed.draftMessage : undefined,
    },
  };
}
