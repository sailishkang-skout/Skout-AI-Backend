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

/**
 * A workspace's way into its own CRM (WB2-023), through the connections and token handling the app already has. A
 * connection is always looked up by the workspace of the session or of the import, never by anything a client sends.
 * Tokens stay here: nothing returns them to a caller outside the server.
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

export function crmAccess(db: Db, config: Env): CrmAccess {
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

export const crmMessage = (failure: CrmSourceError["failure"], label: string) => MESSAGES[failure].replaceAll("{crm}", label);
