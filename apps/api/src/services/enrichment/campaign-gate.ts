import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import type { SendGate } from "./campaign.service.js";

/**
 * ENR-05 — the sequence worker's two entry points into evidence campaigns: the gate it asks
 * before an email, and the hook it calls after an outcome. Kept in a module of their own, and
 * loaded on first use, so the worker does not pull the whole campaign service into its start-up.
 */

export async function campaignSendGate(db: Db, config: Env, workspaceId: string, enrollmentId: string, email: string): Promise<SendGate> {
  const campaigns = await import("./campaign.service.js");
  return campaigns.campaignSendGate(db, config, workspaceId, enrollmentId, email);
}

export async function recordCampaignOutcome(db: Db, workspaceId: string, enrollmentId: string, outcome: "sent" | "replied" | "bounced", at = new Date()): Promise<void> {
  const campaigns = await import("./campaign.service.js");
  return campaigns.recordCampaignOutcome(db, workspaceId, enrollmentId, outcome, at);
}
