import type { Db } from "@skout/db";
import {
  EnrichmentEngine,
  createRegistryFromConfig,
  hasLiveProviders,
  type EmailVerifier,
  type PalConfig,
} from "@skout/pal";
import type { Env } from "../../config/env.js";
import { HttpError } from "../../utils/http.js";
import { getWorkspaceIcp } from "../icp.service.js";
import { writeScoreToOpenSearch } from "../score-opensearch.js";
import { ensureDemoWorkspace } from "../demo-workspace.js";
import { createIntegrationService, workspaceEngineCacheKey } from "../integration.service.js";
import { hasWorkspacePalKeys } from "../integration-providers.js";
import { DbStore } from "./db-store.js";
import { MemoryStore } from "./memory-store.js";
import { EnrichmentService } from "./service.js";
import type { EnrichmentStore } from "./types.js";
import type { ProspectSnapshot as ActivateSnapshot } from "./service.js";
import { applyEnrichmentAutoFill } from "../enrichment-autofill.service.js";

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
    kasprApiKey: config.KASPR_API_KEY,
    lushaApiKey: config.LUSHA_API_KEY,
    contactOutApiKey: config.CONTACTOUT_API_KEY,
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
    kasprBaseUrl: config.KASPR_BASE_URL,
    lushaBaseUrl: config.LUSHA_BASE_URL,
    contactOutBaseUrl: config.CONTACTOUT_BASE_URL,
    cognismBaseUrl: config.COGNISM_BASE_URL,
    requestTimeoutMs: config.ENRICHMENT_REQUEST_TIMEOUT_MS,
  };
}

const engineCache = new Map<string, EnrichmentEngine>();

function buildEngine(config: Env, workspaceOverrides: Partial<PalConfig> = {}): EnrichmentEngine {
  const platform = palConfigFromEnv(config);
  const cacheKey = workspaceEngineCacheKey(platform, workspaceOverrides, config.ENRICHMENT_PHONE_SCORE_GATE);
  const cached = engineCache.get(cacheKey);
  if (cached) return cached;

  const engine = new EnrichmentEngine(createRegistryFromConfig(platform, workspaceOverrides), {
    phoneScoreGate: config.ENRICHMENT_PHONE_SCORE_GATE,
  });
  engineCache.set(cacheKey, engine);
  return engine;
}

export function getStore(db: Db | null): EnrichmentStore {
  return db ? new DbStore(db) : memoryStore;
}

/**
 * Resolves the highest-priority email verifier for a workspace (workspace BYOK key first,
 * then platform key, then a stub). Reuses the same provider waterfall as enrichment so bulk
 * list verification and inline enrichment behave identically.
 */
export async function resolveEmailVerifier(
  db: Db | null,
  config: Env,
  workspaceId: string
): Promise<EmailVerifier> {
  const platform = palConfigFromEnv(config);
  let workspacePal: Partial<PalConfig> = {};
  if (db) {
    const integrationSvc = createIntegrationService(db, config);
    workspacePal = await integrationSvc.loadWorkspacePalConfig(workspaceId);
  }
  return createRegistryFromConfig(platform, workspacePal).emailVerifiers[0]!;
}

/** Build a request-scoped EnrichmentService bound to the right store + providers. */
export function buildEnrichmentService(db: Db | null, config: Env): EnrichmentService {
  const platform = palConfigFromEnv(config);
  const platformEngine = buildEngine(config);
  const integrationSvc = createIntegrationService(db, config);

  const resolveEngine = async (workspaceId: string): Promise<EnrichmentEngine> => {
    let workspacePal: Partial<PalConfig> = {};
    if (db) {
      workspacePal = await integrationSvc.loadWorkspacePalConfig(workspaceId);
    }

    // Production must not invent contacts via stub providers when no API keys exist.
    if (
      config.NODE_ENV === "production" &&
      !hasLiveProviders(platform) &&
      !hasWorkspacePalKeys(workspacePal)
    ) {
      throw new HttpError(
        "enrichment_providers_not_configured",
        503,
        "No enrichment provider API keys are configured for this environment."
      );
    }

    if (!db || !hasWorkspacePalKeys(workspacePal)) return platformEngine;
    return buildEngine(config, workspacePal);
  };

  return new EnrichmentService(
    getStore(db),
    resolveEngine,
    config.AI_SERVICE_URL,
    config.ENRICHMENT_AI_TIMEOUT_MS,
    db ? (ws) => getWorkspaceIcp(db, ws) : undefined,
    db ? (ws) => ensureDemoWorkspace(db, ws) : undefined,
    (result) => writeScoreToOpenSearch(config, result),
    config.OPENROUTER_API_KEY,
    // R13.3 — `activate` always sets prospectId/companyId on the snapshot before calling this.
    db
      ? (ws, snapshot) =>
          applyEnrichmentAutoFill(db, ws, snapshot as ActivateSnapshot & { prospectId: string; companyId: string })
      : undefined
  );
}
