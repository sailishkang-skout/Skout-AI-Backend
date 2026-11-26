import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "@skout/db";
import type { ApiPriceOperation } from "@skout/shared";
import type { ApiPricingService, ResolvedPrice } from "../services/api-pricing.service.js";
import type { QuotaKind, QuotaStore } from "../lib/api-quota.js";
import { availableCredits, commit, release, reserve } from "../services/api-credits.service.js";
import { consumeQuota, limitsForKey, type ApiLimitDefaults } from "../services/api-limits.service.js";
import type { PublicApiScope } from "../services/public-api-keys.service.js";
import { PublicApiError } from "./errors.js";

/**
 * The shared public API pipeline (PAPI-040, public API PRD §6):
 *   auth (onRequest hook, PAPI-024) → scope → rate limit → validate → quota → price → reserve
 *   → handler → commit / release → map → log
 * Every endpoint is a PublicEndpoint; the plugin runs it through `runPipeline`.
 */
export type PriceList = Record<ApiPriceOperation, ResolvedPrice>;

export interface EndpointContext<I> {
  input: I;
  requestId: string;
  workspaceId: string;
  apiKeyId: string;
  prices: PriceList;
  /** Aborted when the request times out; handlers pass it to slow calls. */
  signal: AbortSignal;
}

export interface EndpointResult<O> {
  data: O;
  /** Credits to charge, at most the reservation; 0 for no result (CRED-4). */
  charge: number;
  /** Quota units actually used, when fewer than were taken up front (e.g. a short search page). */
  quotaUsed?: number;
  /** HTTP status for a success, default 200 (202 for async jobs). */
  status?: number;
}

export interface PublicEndpoint<S extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  method: "GET" | "POST" | "DELETE";
  /** Path under /api/public/v1, e.g. /people/search. */
  path: string;
  /** Static scope (PRD §9.2: scopes come from a static map, not URL regexes); "any" for any valid key. */
  scope: PublicApiScope | "any";
  /** The billable operation, for the ledger action and price snapshot; null for free endpoints. */
  operation: ApiPriceOperation | null;
  /** Strict schema for the body (POST) or query (GET/DELETE) merged with path params. */
  input: S;
  /** Most the call can cost, from the current price list; reserved before the handler runs. */
  maxCost: (input: z.infer<S>, prices: PriceList) => number;
  /** Batch endpoints get the lower per-minute rate limit (RL-2). */
  batch?: boolean;
  /** Daily count quota the call uses, taken up front (RL-5, RL-6). */
  quota?: { kind: QuotaKind; units: (input: z.infer<S>) => number };
  /** Live keys: the real work. */
  handle: (ctx: EndpointContext<z.infer<S>>) => Promise<EndpointResult<O>>;
  /** Test keys (CRED-10): deterministic fixture data, never touches the wallet. */
  fixture: (input: z.infer<S>) => O;
}

export interface RateLimitStepResult {
  ok: boolean;
  /** Seconds to wait when refused (Retry-After). */
  retryAfterSeconds?: number;
  /** RateLimit-Limit / -Remaining / -Reset (CONV-5), set on every response. */
  headers?: Record<string, string>;
}

export interface RequestLogEntry {
  requestId: string;
  workspaceId: string | null;
  apiKeyId: string | null;
  method: string;
  endpoint: string;
  statusCode: number;
  errorCode: string | null;
  creditsCharged: number;
  priceApplied: Record<string, number> | null;
  latencyMs: number;
  ip: string;
  userAgent: string | null;
}

export interface PublicApiDeps {
  db: Db;
  pricing: ApiPricingService;
  quotas: QuotaStore;
  limitDefaults: ApiLimitDefaults;
  /** PUBLIC_API_ENABLED. */
  enabled: boolean;
  /** Per-request time limit, default 30 s (PRD §9.5). */
  timeoutMs?: number;
  /** Rate limit step (PAPI-041). Absent = no limit at this layer. */
  rateLimit?: (request: FastifyRequest, endpoint: PublicEndpoint) => Promise<RateLimitStepResult>;
  /** Log step (PAPI-044): one entry per request, including rejected ones. */
  logRequest?: (entry: RequestLogEntry) => Promise<void>;
}

/** What the pipeline learned about a request, read by the log step. */
export interface PublicRequestState {
  endpoint: string;
  creditsCharged: number;
  priceApplied: Record<string, number> | null;
}

declare module "fastify" {
  interface FastifyRequest {
    publicApi?: PublicRequestState;
  }
}

/** Fields that would let a caller pick the workspace (PRD §9.2: it comes only from the key). */
const FORBIDDEN_FIELDS = ["workspace_id", "workspaceId"];

function parseInput<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  if (raw && typeof raw === "object") {
    const bad = FORBIDDEN_FIELDS.filter((f) => f in (raw as Record<string, unknown>));
    if (bad.length) throw new PublicApiError("invalid_request", `The workspace comes from the API key; remove ${bad.join(", ")}.`);
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
    throw new PublicApiError("invalid_request", `${issue?.message ?? "Invalid request"}${where}`, {
      fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PublicApiError("upstream_unavailable", "The request took too long. Nothing was charged; try again."));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one endpoint for one request through every pipeline step after authentication. */
export async function runPipeline(deps: PublicApiDeps, ep: PublicEndpoint, request: FastifyRequest, reply: FastifyReply) {
  const key = request.publicApiKey;
  if (!key) throw new PublicApiError("authentication_failed", "Send a public API key as: Authorization: Bearer sk_live_...");
  const state: PublicRequestState = { endpoint: ep.path, creditsCharged: 0, priceApplied: null };
  request.publicApi = state;

  // Scope (static per endpoint).
  if (ep.scope !== "any" && !key.scopes.includes(ep.scope)) {
    throw new PublicApiError("scope_missing", `This key needs the ${ep.scope} scope for ${ep.method} ${ep.path}.`);
  }

  // Rate limit.
  if (deps.rateLimit) {
    const r = await deps.rateLimit(request, ep);
    for (const [h, v] of Object.entries(r.headers ?? {})) reply.header(h, v);
    if (!r.ok) {
      reply.header("retry-after", String(r.retryAfterSeconds ?? 1));
      throw new PublicApiError("rate_limited", "Too many requests. Slow down and retry after the Retry-After interval.");
    }
  }

  // Validate (body for POST, query for GET/DELETE, plus path params).
  const raw = ep.method === "POST" ? request.body : { ...(request.query as object), ...(request.params as object) };
  const input = parseInput(ep.input, ep.method === "POST" ? { ...((raw as object) ?? {}), ...(request.params as object) } : raw);

  // Test keys: fixture data, no quota, no wallet (CRED-10).
  if (key.type === "test") {
    reply.header("x-credits-charged", "0");
    reply.header("x-credits-remaining", "0");
    return { data: ep.fixture(input) };
  }

  const limits = await limitsForKey(deps.db, deps.limitDefaults, key);

  // Quota (taken up front; unused units refunded below).
  const quotaUnits = ep.quota ? ep.quota.units(input) : 0;
  if (ep.quota && quotaUnits > 0) await consumeQuota(deps.quotas, ep.quota.kind, key.id, quotaUnits, limits);
  const refundQuota = async (used: number) => {
    if (ep.quota && quotaUnits > used) await deps.quotas.refund(ep.quota.kind, key.id, quotaUnits - used);
  };

  // Price.
  const prices = (await deps.pricing.priceList(key.workspaceId)) as PriceList;
  state.priceApplied = ep.operation ? Object.fromEntries(Object.values(prices).map((p) => [p.operation, p.credits])) : null;
  const max = Math.max(0, Math.trunc(ep.maxCost(input, prices)));

  // Reserve (402 insufficient_credits / 429 cap_reached before any work).
  let hold;
  try {
    hold = await reserve(deps.db, { workspaceId: key.workspaceId, apiKeyId: key.id, requestId: String(request.id), max, caps: limits.caps });
  } catch (err) {
    await refundQuota(0);
    throw err;
  }

  // Handler, within the time limit; any failure releases the hold and the quota.
  let result: EndpointResult<unknown>;
  try {
    result = await withTimeout(deps.timeoutMs ?? 30_000, (signal) =>
      ep.handle({ input, requestId: String(request.id), workspaceId: key.workspaceId, apiKeyId: key.id, prices, signal })
    );
  } catch (err) {
    await release(deps.db, hold.holdId);
    await refundQuota(0);
    throw err;
  }

  // Commit the actual charge (0 releases the hold).
  const charge = Math.max(0, Math.min(max, Math.trunc(result.charge)));
  const committed = await commit(deps.db, hold.holdId, charge, ep.operation ?? "free");
  state.creditsCharged = committed.charged;
  await refundQuota(result.quotaUsed ?? quotaUnits);

  // Map.
  const balance = committed.balance ?? (await availableCredits(deps.db, key.workspaceId)).balance;
  reply.header("x-credits-charged", String(committed.charged));
  reply.header("x-credits-remaining", String(balance));
  reply.code(result.status ?? 200);
  return { data: result.data };
}
