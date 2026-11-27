import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { API_PRICE_OPERATIONS, apiPriceValueSchema, type ApiPriceOperation } from "@skout/shared";
import { HttpError } from "../utils/http.js";
import { getConfig, saveConfig, type AdminConfigContext } from "./cops-admin-config.service.js";
import { internalWorkspaceId, isInternalWorkspace } from "./ops-access.service.js";
import { SCORE_CREDIT_COST } from "./enrichment/service.js";

const { entitlements, auditLogs } = schema;

/**
 * Public API prices (PAPI-030, public API PRD CRED-11, D4, §8). Each operation's price is read in
 * this order:
 *   1. the workspace override, entitlement `api.price.<operation>`
 *   2. the global default in CustomerOps admin config (kind `api_price`, key `default`), saved in the
 *      internal Skout workspace (COPS-15: INTERNAL_WORKSPACE_ID, else the Ops access holders' workspace)
 *   3. the code default below
 * Prices are cached for at most 60 seconds, so a change reaches new requests within a minute with no
 * deploy; changes made through this service also drop the cache at once on this instance.
 */
export type PriceSource = "workspace" | "global" | "default";
export interface ResolvedPrice {
  operation: ApiPriceOperation;
  credits: number;
  source: PriceSource;
}

export const PRICE_CACHE_TTL_MS = 60_000;
export const API_PRICE_ENTITLEMENT_PREFIX = "api.price.";
export const API_PRICE_CONFIG_KIND = "api_price" as const;
export const API_PRICE_CONFIG_KEY = "default";

export interface PricingConfig {
  /** INTERNAL_WORKSPACE_ID (COPS-15); when unset the Ops access holders' workspace is used. */
  INTERNAL_WORKSPACE_ID: string | undefined;
  /** SEARCH_CREDIT_COST, today's in-app search price (PRD §8.1: search.index_page starts at it). */
  searchCreditCost: number;
}

/** PRD §8 starting defaults. Scoring follows the app's own scoring price. */
export function codeDefaultPrices(cfg: Pick<PricingConfig, "searchCreditCost">): Record<ApiPriceOperation, number> {
  return {
    "search.index_page": cfg.searchCreditCost,
    "search.vendor_result": 1,
    "people.lookup": 1,
    "companies.lookup": 1,
    "companies.jobs": 1,
    "contacts.email_find": 1,
    "contacts.phone_find": 10,
    "emails.verify": 0,
    "scores.score": SCORE_CREDIT_COST,
  };
}

export function isApiPriceOperation(op: string): op is ApiPriceOperation {
  return (API_PRICE_OPERATIONS as readonly string[]).includes(op);
}

/** Reads a stored price; anything that isn't a whole, non-negative number counts as unset. */
function asPrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "object" && value !== null ? (value as { credits?: unknown }).credits : undefined;
  return apiPriceValueSchema.safeParse(n).success ? (n as number) : null;
}

export class ApiPricingService {
  private globalCache: { at: number; prices: Partial<Record<ApiPriceOperation, number>> } | null = null;
  private readonly workspaceCache = new Map<string, { at: number; prices: Partial<Record<ApiPriceOperation, number>> }>();

  constructor(
    private readonly db: Db,
    private readonly cfg: PricingConfig,
    private readonly clock: () => number = Date.now
  ) {}

  /** The price of one operation for a workspace, and where it came from. */
  async priceFor(workspaceId: string, operation: ApiPriceOperation): Promise<ResolvedPrice> {
    const list = await this.priceList(workspaceId);
    return list[operation];
  }

  /** Every operation's current price for a workspace (CRED-13: GET /usage and the docs show this). */
  async priceList(workspaceId: string): Promise<Record<ApiPriceOperation, ResolvedPrice>> {
    const [ws, global] = await Promise.all([this.workspacePrices(workspaceId), this.globalPrices()]);
    const defaults = codeDefaultPrices(this.cfg);
    const out = {} as Record<ApiPriceOperation, ResolvedPrice>;
    for (const op of API_PRICE_OPERATIONS) {
      if (ws[op] !== undefined) out[op] = { operation: op, credits: ws[op]!, source: "workspace" };
      else if (global[op] !== undefined) out[op] = { operation: op, credits: global[op]!, source: "global" };
      else out[op] = { operation: op, credits: defaults[op], source: "default" };
    }
    return out;
  }

  /** The prices applied to a request, as stored on its api_request_log row (CRED-12). */
  async priceSnapshot(workspaceId: string, operations: ApiPriceOperation[]): Promise<Record<string, number>> {
    const list = await this.priceList(workspaceId);
    return Object.fromEntries(operations.map((op) => [op, list[op].credits]));
  }

  /** Drops cached prices on this instance (other instances pick changes up within the TTL). */
  invalidate(workspaceId?: string): void {
    if (workspaceId) this.workspaceCache.delete(workspaceId);
    else this.workspaceCache.clear();
    this.globalCache = null;
  }

  private fresh(at: number) {
    return this.clock() - at < PRICE_CACHE_TTL_MS;
  }

  private async workspacePrices(workspaceId: string): Promise<Partial<Record<ApiPriceOperation, number>>> {
    const hit = this.workspaceCache.get(workspaceId);
    if (hit && this.fresh(hit.at)) return hit.prices;
    const keys = [...API_PRICE_OPERATIONS.map((op) => API_PRICE_ENTITLEMENT_PREFIX + op), "enrichment.score_credit_cost"];
    const rows = await this.db
      .select({ key: entitlements.key, value: entitlements.value })
      .from(entitlements)
      .where(and(eq(entitlements.workspaceId, workspaceId), inArray(entitlements.key, keys)));
    const prices: Partial<Record<ApiPriceOperation, number>> = {};
    for (const r of rows) {
      if (!r.key.startsWith(API_PRICE_ENTITLEMENT_PREFIX)) continue;
      const op = r.key.slice(API_PRICE_ENTITLEMENT_PREFIX.length);
      const v = asPrice(r.value);
      if (isApiPriceOperation(op) && v !== null) prices[op] = v;
    }
    // PRD §8: scoring costs what the app charges this workspace for scoring, unless overridden for the API.
    if (prices["scores.score"] === undefined) {
      const appScore = asPrice(rows.find((r) => r.key === "enrichment.score_credit_cost")?.value);
      if (appScore !== null) prices["scores.score"] = appScore;
    }
    this.workspaceCache.set(workspaceId, { at: this.clock(), prices });
    return prices;
  }

  private async globalPrices(): Promise<Partial<Record<ApiPriceOperation, number>>> {
    if (this.globalCache && this.fresh(this.globalCache.at)) return this.globalCache.prices;
    const prices: Partial<Record<ApiPriceOperation, number>> = {};
    const internal = await internalWorkspaceId(this.db, this.cfg);
    if (internal) {
      const saved = await getConfig(this.db, internal, API_PRICE_CONFIG_KIND, API_PRICE_CONFIG_KEY);
      const stored = (saved?.value as { prices?: Record<string, unknown> } | undefined)?.prices ?? {};
      for (const [op, value] of Object.entries(stored)) {
        const v = asPrice(value);
        if (isApiPriceOperation(op) && v !== null) prices[op] = v;
      }
    }
    this.globalCache = { at: this.clock(), prices };
    return prices;
  }

  // --- Changing prices (OPS-2; the CustomerOps screens come in PAPI-091) -----------------------

  /**
   * Sets or clears (null) one workspace's override for an operation, with an audit row that has who,
   * when, the old value and the new value.
   */
  async setWorkspacePrice(
    actor: { workspaceId: string; staffId: string; requestId?: string },
    customerWorkspaceId: string,
    operation: string,
    credits: number | null,
    reason: string
  ): Promise<ResolvedPrice> {
    if (!isApiPriceOperation(operation)) throw new HttpError(`Unknown operation: ${operation}`, 422);
    if (credits !== null && !apiPriceValueSchema.safeParse(credits).success) {
      throw new HttpError("A price is a whole number of credits from 0 to 100000", 422);
    }
    const why = reason?.trim();
    if (!why) throw new HttpError("Give a reason for the price change", 422);
    const key = API_PRICE_ENTITLEMENT_PREFIX + operation;
    await this.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [before] = await tx
        .select({ value: entitlements.value })
        .from(entitlements)
        .where(and(eq(entitlements.workspaceId, customerWorkspaceId), eq(entitlements.key, key)))
        .for("update")
        .limit(1);
      if (credits === null) {
        await tx.delete(entitlements).where(and(eq(entitlements.workspaceId, customerWorkspaceId), eq(entitlements.key, key)));
      } else {
        await tx
          .insert(entitlements)
          .values({ workspaceId: customerWorkspaceId, key, value: credits, source: "customerops", updatedAt: new Date() })
          .onConflictDoUpdate({ target: [entitlements.workspaceId, entitlements.key], set: { value: credits, source: "customerops", updatedAt: new Date() } });
      }
      await tx.insert(auditLogs).values({
        workspaceId: customerWorkspaceId,
        actorType: "staff",
        actorRef: actor.staffId,
        action: "api_price.workspace_override_set",
        entityType: "api_price",
        entityId: customerWorkspaceId,
        beforeState: { operation, credits: asPrice(before?.value) },
        afterState: { operation, credits },
        reason: why,
        correlationId: actor.requestId ?? null,
      });
    });
    this.invalidate(customerWorkspaceId);
    return this.priceFor(customerWorkspaceId, operation);
  }

  /**
   * Saves the global default prices as a new admin-config version (audited by the config store with
   * the old and new values). Operations left out keep the code default.
   */
  async setGlobalPrices(ctx: AdminConfigContext, prices: Record<string, number>, reason: string): Promise<void> {
    if (!(await isInternalWorkspace(this.db, this.cfg, ctx.workspaceId))) {
      throw new HttpError("Global API prices can only be changed from the internal Skout (CustomerOps) workspace", 403);
    }
    await saveConfig(this.db, ctx, API_PRICE_CONFIG_KIND, API_PRICE_CONFIG_KEY, { value: { prices }, reason });
    this.invalidate();
  }
}
