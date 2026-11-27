import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { AttemptLog } from "@skout/pal";
import { createLogger } from "@skout/observability";

const log = createLogger("provider-cost");

export type ProviderCallOutcome = "ok" | "miss" | "error";
export type ProviderCostSource = "enrichment" | "search";

/** One external data-provider call (PAPI-013, CRED-6). */
export interface ProviderCall {
  provider: string;
  operation: string;
  outcome: ProviderCallOutcome;
  /** Billable units the provider counts, e.g. results returned; 1 for a single lookup. */
  units: number;
  latencyMs?: number;
  credentialSource?: "platform" | "workspace";
  errorMessage?: string;
}

export interface ProviderCostContext {
  source: ProviderCostSource;
  workspaceId?: string | null;
  apiKeyId?: string | null;
  requestId?: string | null;
}

interface UnitCost {
  perCall?: number;
  perUnit?: number;
}

/** Parses PROVIDER_UNIT_COSTS_JSON ({"provider:operation": {perCall, perUnit}} in USD millionths). */
export function parseProviderUnitCosts(raw: string | undefined): Map<string, UnitCost> {
  const out = new Map<string, UnitCost>();
  if (!raw?.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, UnitCost>;
    for (const [key, v] of Object.entries(parsed ?? {})) {
      if (!v || typeof v !== "object") continue;
      const perCall = Number.isFinite(v.perCall) && v.perCall! >= 0 ? Math.round(v.perCall!) : undefined;
      const perUnit = Number.isFinite(v.perUnit) && v.perUnit! >= 0 ? Math.round(v.perUnit!) : undefined;
      out.set(key.toLowerCase(), { perCall, perUnit });
    }
  } catch (err) {
    log.error("PROVIDER_UNIT_COSTS_JSON is not valid JSON; provider costs will be recorded as unknown", err);
  }
  return out;
}

/**
 * What a call cost Skout in USD millionths. A call on the workspace's own key costs Skout nothing;
 * an unconfigured provider/operation is unknown (null), never guessed.
 */
export function providerCallCostMicros(costs: Map<string, UnitCost>, call: ProviderCall): number | null {
  if (call.credentialSource === "workspace") return 0;
  const c = costs.get(`${call.provider}:${call.operation}`.toLowerCase());
  if (!c || (c.perCall === undefined && c.perUnit === undefined)) return null;
  return (c.perCall ?? 0) + (c.perUnit ?? 0) * Math.max(0, call.units);
}

/** Enrichment waterfall attempts that were real provider calls (not cache hits, gates or skips). */
export function providerCallsFromAttempts(attempts: AttemptLog[]): ProviderCall[] {
  return attempts
    .filter((a) => a.status !== "skipped" && a.credentialSource !== undefined)
    .map((a) => ({
      provider: a.provider,
      operation: a.operation,
      outcome: a.status as ProviderCallOutcome,
      units: a.status === "ok" ? 1 : 0,
      latencyMs: a.latencyMs,
      credentialSource: a.credentialSource,
      errorMessage: a.status === "error" ? a.detail : undefined,
    }));
}

export type ProviderCostRecorder = (calls: ProviderCall[], ctx: ProviderCostContext) => Promise<void>;

/**
 * Writes one provider_cost_events row per call. Never throws: losing a cost row must not fail the
 * user's search or enrichment, so a failed insert is logged instead.
 */
export function createProviderCostRecorder(db: Db | null | undefined, unitCostsJson?: string): ProviderCostRecorder {
  const costs = parseProviderUnitCosts(unitCostsJson);
  return async (calls, ctx) => {
    // Some callers pass a stand-in db when Postgres isn't configured.
    if (!db || typeof (db as { insert?: unknown }).insert !== "function" || calls.length === 0) return;
    try {
      await db.insert(schema.providerCostEvents).values(
        calls.map((c) => ({
          workspaceId: ctx.workspaceId ?? null,
          apiKeyId: ctx.apiKeyId ?? null,
          requestId: ctx.requestId ?? null,
          source: ctx.source,
          provider: c.provider,
          operation: c.operation,
          outcome: c.outcome,
          credentialSource: c.credentialSource ?? "platform",
          units: Math.max(0, Math.trunc(c.units)),
          costMicros: providerCallCostMicros(costs, c),
          latencyMs: c.latencyMs == null ? null : Math.max(0, Math.round(c.latencyMs)),
          errorMessage: c.errorMessage ? c.errorMessage.slice(0, 500) : null,
        }))
      );
    } catch (err) {
      log.error("failed to record provider cost events", err, { source: ctx.source, calls: calls.length });
    }
  };
}
