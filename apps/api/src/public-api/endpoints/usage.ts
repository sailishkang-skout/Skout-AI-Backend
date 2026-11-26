import { z } from "zod";
import type { Db } from "@skout/db";
import { API_PRICE_OPERATIONS, type ApiPriceOperation } from "@skout/shared";
import type { Env } from "../../config/env.js";
import { availableCredits } from "../../services/api-credits.service.js";
import { apiUsage, type ApiUsage } from "../../services/api-limits.service.js";
import type { PublicEndpoint } from "../pipeline.js";

/**
 * GET /usage (PAPI-061, public API PRD §7.3, CRED-13).
 *
 * The workspace's Data Credit balance (and how much is held for in-flight API work), what this key and
 * the workspace spent through the API today and this month, the key's caps and quotas with what is
 * left, and the price list that applies to this workspace right now. Free, needs usage:read.
 */
export interface UsageResponse extends ApiUsage {
  credits: { balance: number; held: number; available: number };
  /** Credits per operation for this workspace, as currently charged (CRED-13). */
  prices: Record<ApiPriceOperation, number>;
}

const input = z.object({}).strict();

export function createUsageEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof input, UsageResponse> {
  return {
    method: "GET",
    path: "/usage",
    scope: "usage:read",
    operation: null,
    input,
    maxCost: () => 0,

    async handle({ workspaceId, apiKeyId, prices, limits, quotas }) {
      const [credits, usage] = await Promise.all([
        availableCredits(deps.db, workspaceId),
        apiUsage(deps.db, quotas, { id: apiKeyId, workspaceId }, limits),
      ]);
      return {
        data: {
          credits,
          ...usage,
          prices: Object.fromEntries(API_PRICE_OPERATIONS.map((op) => [op, prices[op].credits])) as Record<ApiPriceOperation, number>,
        },
        charge: 0,
      };
    },

    fixture: () => {
      const day = "2026-01-02T00:00:00.000Z";
      return {
        credits: { balance: 1000, held: 0, available: 1000 },
        spent: { key_today: 0, key_this_month: 0, workspace_api_today: 0, workspace_api_this_month: 0 },
        caps: { key_daily: null, key_monthly: null, workspace_monthly: null },
        quotas: {
          email_verifications_daily: { limit: 5000, used: 0, remaining: 5000, resets_at: day },
          search_results_daily: { limit: 10000, used: 0, remaining: 10000, resets_at: day },
        },
        prices: Object.fromEntries(API_PRICE_OPERATIONS.map((op) => [op, 0])) as Record<ApiPriceOperation, number>,
      };
    },
  };
}
