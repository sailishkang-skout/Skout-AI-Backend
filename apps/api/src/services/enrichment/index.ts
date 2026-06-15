import type { Db } from "@skout/db";
import { EnrichmentEngine, createRegistryFromConfig, type PalConfig } from "@skout/pal";
import type { Env } from "../../config/env.js";
import { getWorkspaceIcp } from "../icp.service.js";
import { DbStore } from "./db-store.js";
import { MemoryStore } from "./memory-store.js";
import { EnrichmentService } from "./service.js";
import type { EnrichmentStore } from "./types.js";

export * from "./types.js";
export { EnrichmentService } from "./service.js";
export type { ProspectSnapshot, EnrichOptions } from "./service.js";

// Single in-memory store shared across requests when no DB is configured.
const memoryStore = new MemoryStore();

function palConfigFromEnv(config: Env): PalConfig {
  return {
    hunterApiKey: config.HUNTER_API_KEY,
    millionVerifierApiKey: config.MILLIONVERIFIER_API_KEY,
    zeroBounceApiKey: config.ZEROBOUNCE_API_KEY,
    neverBounceApiKey: config.NEVERBOUNCE_API_KEY,
    pdlApiKey: config.PDL_API_KEY,
    revenueBaseApiKey: config.REVENUEBASE_API_KEY,
    exploriumApiKey: config.EXPLORIUM_API_KEY,
    coresignalApiKey: config.CORESIGNAL_API_KEY,
    datagmaApiKey: config.DATAGMA_API_KEY,
    cognismApiKey: config.COGNISM_API_KEY,
    hunterBaseUrl: config.HUNTER_BASE_URL,
    millionVerifierBaseUrl: config.MILLIONVERIFIER_BASE_URL,
    zeroBounceBaseUrl: config.ZEROBOUNCE_BASE_URL,
    neverBounceBaseUrl: config.NEVERBOUNCE_BASE_URL,
    pdlBaseUrl: config.PDL_BASE_URL,
    revenueBaseBaseUrl: config.REVENUEBASE_BASE_URL,
    exploriumBaseUrl: config.EXPLORIUM_BASE_URL,
    coresignalBaseUrl: config.CORESIGNAL_BASE_URL,
    datagmaBaseUrl: config.DATAGMA_BASE_URL,
    cognismBaseUrl: config.COGNISM_BASE_URL,
    requestTimeoutMs: config.ENRICHMENT_REQUEST_TIMEOUT_MS,
  };
}

// Engine cache keyed by provider + gate config (rebuilt when env changes).
let cachedEngine: EnrichmentEngine | null = null;
let cachedEngineKey: string | null = null;

function engineCacheKey(config: Env): string {
  return JSON.stringify({
    pal: palConfigFromEnv(config),
    phoneScoreGate: config.ENRICHMENT_PHONE_SCORE_GATE,
  });
}

function getEngine(config: Env): EnrichmentEngine {
  const key = engineCacheKey(config);
  if (!cachedEngine || cachedEngineKey !== key) {
    cachedEngine = new EnrichmentEngine(createRegistryFromConfig(palConfigFromEnv(config)), {
      phoneScoreGate: config.ENRICHMENT_PHONE_SCORE_GATE,
    });
    cachedEngineKey = key;
  }
  return cachedEngine;
}

export function getStore(db: Db | null): EnrichmentStore {
  return db ? new DbStore(db) : memoryStore;
}

/** Build a request-scoped EnrichmentService bound to the right store + providers. */
export function buildEnrichmentService(db: Db | null, config: Env): EnrichmentService {
  return new EnrichmentService(
    getStore(db),
    getEngine(config),
    config.AI_SERVICE_URL,
    config.ENRICHMENT_AI_TIMEOUT_MS,
    db ? (ws) => getWorkspaceIcp(db, ws) : undefined
  );
}
