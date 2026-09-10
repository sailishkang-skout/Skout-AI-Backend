import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { SequenceService } from "./sequence.service.js";

const log = createLogger("apollo-import.service");

const APOLLO_BASE = "https://api.apollo.io/v1";

export interface ApolloSequenceSummary {
  id: string;
  name: string;
  numSteps: number;
  active: boolean;
}

interface ApolloEmailerCampaign {
  id: string;
  name: string;
  active?: boolean;
  emailer_steps?: ApolloEmailerStep[];
}

interface ApolloEmailerStep {
  id: string;
  // Apollo step types include "auto_email", "manual_email", "call", "linkedin_step", etc.
  // depending on plan/version — mapped defensively below.
  type?: string;
  priority?: number;
  wait_time?: number; // seconds
  subject?: string;
  email_template?: { body_text?: string; body_html?: string; subject?: string } | null;
}

async function apolloFetch<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    ...init,
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.body ?? JSON.stringify({ api_key: apiKey }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new HttpError("apollo_unauthorized", 401, { detail: "Apollo rejected the API key" });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError("apollo_request_failed", 502, { status: res.status, detail: text.slice(0, 500) });
  }
  return res.json() as Promise<T>;
}

/**
 * R22.3 — list the workspace's Apollo "Emailer Campaigns" (Apollo's name for sequences).
 *
 * Honest caveat: Apollo's sequence/cadence export surface differs by plan tier and has changed
 * shape across API versions — this targets the documented v1 `emailer_campaigns` endpoint. If
 * your Apollo plan doesn't expose it, this call fails with a clear `apollo_request_failed` /
 * `apollo_unauthorized` error rather than silently returning nothing.
 */
export async function listApolloSequences(apiKey: string): Promise<ApolloSequenceSummary[]> {
  const data = await apolloFetch<{ emailer_campaigns?: ApolloEmailerCampaign[] }>(
    "/emailer_campaigns/search",
    apiKey,
    { body: JSON.stringify({ api_key: apiKey, page: 1, per_page: 100 }) }
  );
  const campaigns = data.emailer_campaigns ?? [];
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    numSteps: c.emailer_steps?.length ?? 0,
    active: c.active ?? false,
  }));
}

/** Maps an Apollo step type to one of Skout's sequence step types. Unknown types fall back to "task". */
function mapStepType(apolloType: string | undefined): "email" | "call" | "linkedin" | "task" {
  const t = (apolloType ?? "").toLowerCase();
  if (t.includes("email")) return "email";
  if (t.includes("call")) return "call";
  if (t.includes("linkedin")) return "linkedin";
  return "task";
}

/** R22.3 — fetch one Apollo campaign's steps and materialize it as a Skout draft sequence. */
export async function importApolloSequence(
  db: Db,
  workspaceId: string,
  apiKey: string,
  campaignId: string
): Promise<{ sequenceId: string; name: string; stepCount: number; skippedSteps: number }> {
  const data = await apolloFetch<{ emailer_campaign?: ApolloEmailerCampaign }>(
    `/emailer_campaigns/${encodeURIComponent(campaignId)}`,
    apiKey,
    { method: "GET" }
  );
  const campaign = data.emailer_campaign;
  if (!campaign) throw new HttpError("apollo_campaign_not_found", 404);

  const rawSteps = [...(campaign.emailer_steps ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  let skippedSteps = 0;
  const steps = rawSteps.map((s) => {
    const stepType = mapStepType(s.type);
    if (stepType === "task") skippedSteps += 1; // couldn't confidently map — imported as a manual task step, not dropped
    return {
      stepType,
      delayDays: s.wait_time ? Math.max(0, Math.round(s.wait_time / 86_400)) : 0,
      delayUnit: "days" as const,
      subject: s.email_template?.subject ?? s.subject ?? null,
      bodyTemplate: s.email_template?.body_html ?? s.email_template?.body_text ?? null,
    };
  });

  const sequenceService = new SequenceService(db);
  const created = await sequenceService.createGeneratedSequence(workspaceId, {
    name: `${campaign.name} (from Apollo)`,
    steps,
  });

  log.info("apollo sequence imported", { workspaceId, campaignId, sequenceId: created.id, stepCount: steps.length });
  return { sequenceId: created.id, name: created.name, stepCount: steps.length, skippedSteps };
}
