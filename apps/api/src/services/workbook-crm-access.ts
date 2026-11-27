import { createHash } from "node:crypto";
import { schema, scopedTo, type Db } from "@skout/db";
import { eq } from "drizzle-orm";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { getCrmConnector } from "./crm-connector.registry.js";
import { crmProviderLabel } from "./crm-alerts.service.js";
import { markConnectionNeedsReauth } from "./crm-auth-lifecycle.service.js";
import { ensureFreshTokens } from "./crm-export.runner.js";
import { createHubSpotCredentialsStore } from "./hubspot-credentials.store.js";
import { CrmSourceError, type CrmRecordSource } from "./crm-record-source.js";
import { apolloContactSource } from "./import-adapters/apollo.adapter.js";
import { createIntegrationService } from "./integration.service.js";

/**
 * A workspace's way into its own CRM (WB2-023) or Apollo account (WB2-024), through the connections, tokens and saved
 * keys the app already has. A connection is always looked up by the workspace of the session or of the import, never by
 * anything a client sends. Tokens and keys stay here: nothing returns them to a caller outside the server.
 */
const { crmConnections } = schema;

export type CrmConnectionStatus = "connected" | "needs_reauth" | "not_connected" | "not_configured" | "not_available";

export interface CrmSession {
  accessToken: string;
  /** The CRM account (HubSpot: portal) the token belongs to. Record ids only mean something within it. */
  accountId: string;
}

export interface CrmAccess {
  /** The record source of a provider, or null when records cannot be read from it. */
  source(provider: string): CrmRecordSource | null;
  label(provider: string): string;
  status(workspaceId: string, provider: string): Promise<CrmConnectionStatus>;
  /** Throws `CrmSourceError`. */
  open(workspaceId: string, provider: string): Promise<CrmSession>;
  /** Records that the CRM no longer accepts the connection, so the workspace is told to reconnect. */
  expired(workspaceId: string, provider: string): Promise<void>;
}

/** Providers whose tokens this server knows how to get. A provider needs this and a record source to be offered. */
interface TokenSupport {
  configured(config: Env): boolean;
  tokens(db: Db, config: Env, workspaceId: string): Promise<string>;
}

const TOKENS: Record<string, TokenSupport> = {
  hubspot: {
    configured: (config) => Boolean(config.HUBSPOT_CLIENT_ID && config.HUBSPOT_CLIENT_SECRET),
    tokens: async (db, config, workspaceId) => (await ensureFreshTokens(db, config, createHubSpotCredentialsStore(config), workspaceId)).accessToken,
  },
};

/** Which account a token belongs to, remembered for as long as the token is likely to live. */
const accounts = new Map<string, { id: string; until: number }>();
const ACCOUNT_KEPT_MS = 10 * 60 * 1000;

async function accountOf(provider: string, accessToken: string): Promise<string> {
  const key = createHash("sha256").update(`${provider}:${accessToken}`).digest("hex");
  const known = accounts.get(key);
  if (known && known.until > Date.now()) return known.id;
  const id = await getCrmConnector(provider)!.auth.getPortalId(accessToken);
  if (accounts.size > 1_000) accounts.clear();
  accounts.set(key, { id, until: Date.now() + ACCOUNT_KEPT_MS });
  return id;
}

/** Apollo is connected with the workspace's own API key, saved in Settings → Integrations. */
function apolloAccess(db: Db, config: Env): CrmAccess {
  const connection = (workspaceId: string) => createIntegrationService(db, config).getProviderConnection(workspaceId, "apollo");
  const status = async (workspaceId: string): Promise<CrmConnectionStatus> => {
    const found = await connection(workspaceId);
    if (!found) return "not_connected";
    return found.status === "active" && found.apiKey ? "connected" : "needs_reauth";
  };
  return {
    source: () => apolloContactSource,
    label: () => "Apollo",
    status,
    // A rejected key is reported where it is used; the saved key is the workspace's to change.
    expired: async () => {},
    async open(workspaceId) {
      const found = await connection(workspaceId);
      if (!found) throw new CrmSourceError("not_connected");
      if (found.status !== "active" || !found.apiKey) throw new CrmSourceError("reauth");
      return { accessToken: found.apiKey, accountId: found.revision };
    },
  };
}

export function crmAccess(db: Db, config: Env): CrmAccess {
  const apollo = apolloAccess(db, config);
  const crm = connectorAccess(db, config);
  const of = (provider: string) => (provider === "apollo" ? apollo : crm);
  return {
    source: (provider) => of(provider).source(provider),
    label: (provider) => of(provider).label(provider),
    status: (workspaceId, provider) => of(provider).status(workspaceId, provider),
    open: (workspaceId, provider) => of(provider).open(workspaceId, provider),
    expired: (workspaceId, provider) => of(provider).expired(workspaceId, provider),
  };
}

function connectorAccess(db: Db, config: Env): CrmAccess {
  const source = (provider: string) => (TOKENS[provider] ? (getCrmConnector(provider)?.records ?? null) : null);

  async function status(workspaceId: string, provider: string): Promise<CrmConnectionStatus> {
    if (!source(provider)) return "not_available";
    const [row] = await db
      .select({ status: crmConnections.status })
      .from(crmConnections)
      .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
      .limit(1);
    if (row?.status === "needs_reauth") return "needs_reauth";
    if (row?.status === "connected") return "connected";
    return TOKENS[provider]!.configured(config) ? "not_connected" : "not_configured";
  }

  const expired = (workspaceId: string, provider: string) =>
    markConnectionNeedsReauth(db, config, { workspaceId, provider, reason: "The CRM rejected the stored access" });

  return {
    source,
    label: (provider) => getCrmConnector(provider)?.label ?? crmProviderLabel(provider),
    status,
    expired,
    async open(workspaceId, provider) {
      const current = await status(workspaceId, provider);
      if (current === "needs_reauth") throw new CrmSourceError("reauth");
      if (current !== "connected") throw new CrmSourceError("not_connected");
      let accessToken: string;
      try {
        accessToken = await TOKENS[provider]!.tokens(db, config, workspaceId);
      } catch (error) {
        const refusal = error instanceof HttpError ? error.message : "";
        if (refusal.endsWith("needs_reauth")) throw new CrmSourceError("reauth");
        if (refusal.endsWith("not_connected")) throw new CrmSourceError("not_connected");
        throw new CrmSourceError("unavailable");
      }
      try {
        return { accessToken, accountId: await accountOf(provider, accessToken) };
      } catch (error) {
        if (error instanceof Error && /\b401\b/.test(error.message)) {
          await expired(workspaceId, provider);
          throw new CrmSourceError("reauth");
        }
        throw new CrmSourceError("unavailable");
      }
    },
  };
}

/** Apollo is not a CRM, so its refusals carry codes of their own. */
const APOLLO_CODES = {
  CRM_NOT_CONNECTED: "APOLLO_NOT_CONNECTED",
  CRM_RECONNECT_REQUIRED: "APOLLO_RECONNECT_REQUIRED",
  CRM_SCOPE_MISSING: "APOLLO_SCOPE_MISSING",
  CRM_RATE_LIMITED: "APOLLO_RATE_LIMITED",
  CRM_UNAVAILABLE: "APOLLO_UNAVAILABLE",
  CRM_UNKNOWN_FIELD: "APOLLO_UNKNOWN_FIELD",
  CRM_UNKNOWN_VIEW: "APOLLO_UNKNOWN_LIST",
  CRM_VIEW_NOT_FOUND: "APOLLO_UNKNOWN_LIST",
  CRM_QUERY_REJECTED: "APOLLO_SEARCH_REJECTED",
  CRM_ACCOUNT_CHANGED: "APOLLO_CONNECTION_CHANGED",
} as const;
export type ApolloErrorCode = (typeof APOLLO_CODES)[keyof typeof APOLLO_CODES];

export const providerCode = <C extends keyof typeof APOLLO_CODES>(provider: string, code: C): C | ApolloErrorCode => (provider === "apollo" ? APOLLO_CODES[code] : code);

/** What a person is told. `{crm}` is the CRM's name. */
const MESSAGES: Record<CrmSourceError["failure"], string> = {
  not_connected: "{crm} isn't connected. Connect it in Settings, then try again.",
  reauth: "{crm} access expired or was revoked. Reconnect {crm} in Settings, then try again.",
  scope: "The {crm} connection doesn't have permission to read this. Reconnect {crm} in Settings and grant it, then try again.",
  rate_limited: "{crm} is limiting requests right now. Try again in a minute.",
  unavailable: "{crm} couldn't be reached. Try again shortly.",
  not_found: "That {crm} selection no longer exists. Choose it again.",
  rejected: "{crm} refused the request. Check the fields and filters you chose.",
};

const APOLLO_MESSAGES: Partial<typeof MESSAGES> = {
  not_connected: "Apollo isn't connected. Add your Apollo API key in Settings → Integrations, then try again.",
  reauth: "Apollo rejected the saved API key. It may have been revoked or replaced. Save a valid key in Settings → Integrations, then try again.",
  scope: "The Apollo API key isn't allowed to read this. Use a key with access to it, or a master key, on an Apollo plan that includes API access, and save it in Settings → Integrations.",
  rate_limited: "Apollo is limiting requests right now. Try again later.",
  not_found: "That Apollo list no longer exists. Choose it again.",
  rejected: "Apollo refused the search. Change it and try again.",
};

export const crmMessage = (provider: string, failure: CrmSourceError["failure"], label: string) =>
  ((provider === "apollo" ? APOLLO_MESSAGES[failure] : undefined) ?? MESSAGES[failure]).replaceAll("{crm}", label);
