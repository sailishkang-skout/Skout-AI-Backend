import { loadEnv } from "../config/env.js";
import { insertAnalyticsEvent } from "../lib/clickhouse.js";

let cachedEnv: ReturnType<typeof loadEnv> | undefined;

function env() {
  if (!cachedEnv) cachedEnv = loadEnv();
  return cachedEnv;
}

/** Fire-and-forget analytics event (ClickHouse when configured). */
export function trackAnalyticsEvent(
  workspaceId: string,
  eventType: string,
  opts?: { amount?: number; referenceId?: string; metadata?: Record<string, unknown> }
): void {
  void insertAnalyticsEvent(env(), {
    workspaceId,
    eventType,
    amount: opts?.amount,
    referenceId: opts?.referenceId,
    metadata: opts?.metadata,
  });
}

export function trackCreditSpend(workspaceId: string, amount: number, action: string, ref?: string): void {
  trackAnalyticsEvent(workspaceId, "credit_spend", {
    amount: -Math.abs(amount),
    referenceId: ref,
    metadata: { action },
  });
}

export function trackCreditAdd(workspaceId: string, amount: number, action: string, ref?: string): void {
  trackAnalyticsEvent(workspaceId, "credit_add", {
    amount: Math.abs(amount),
    referenceId: ref,
    metadata: { action },
  });
}

export function trackEnrichmentJob(
  workspaceId: string,
  status: string,
  creditsUsed: number,
  jobId: string
): void {
  trackAnalyticsEvent(workspaceId, "enrichment_job", {
    amount: creditsUsed,
    referenceId: jobId,
    metadata: { status },
  });
}
