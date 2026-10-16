import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { notifyCrmAdmins } from "./crm-alerts.service.js";

const { crmConnections } = schema;
const log = createLogger("crm-auth-lifecycle");

export class CrmGrantExpiredError extends Error {
  readonly provider: string;
  readonly reason: string;

  constructor(provider: string, reason: string) {
    super(`CRM ${provider} grant has expired or was revoked: ${reason}`);
    this.name = "CrmGrantExpiredError";
    this.provider = provider;
    this.reason = reason;
  }
}

export function isCrmGrantExpiredError(err: unknown): boolean {
  if (err instanceof CrmGrantExpiredError) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("bad_refresh_token") ||
    msg.includes("expired_refresh_token") ||
    msg.includes("invalid_grant") ||
    msg.includes("refresh token is invalid") ||
    msg.includes("token has expired") ||
    msg.includes("token has been revoked") ||
    msg.includes("hubspot_token_expired") ||
    msg.includes("hubspot_grant_expired") ||
    msg.includes("needs_reauth") ||
    msg.includes("failed: 401") ||
    msg.includes("status: 401")
  );
}

export interface MarkConnectionNeedsReauthParams {
  workspaceId: string;
  provider: string;
  reason: string;
  connectionId?: string;
}

/**
 * Marks a CRM connection as 'needs_reauth' and alerts the workspace's Admin and Owner members
 * in-app. Used when refresh tokens are rejected, grants are revoked by the user in the provider,
 * or a 401 shows the authorization has expired. Only the change into needs_reauth alerts, so a
 * second caller (another worker, a retry) finds the status already set and notifies nobody.
 */
export async function markConnectionNeedsReauth(
  db: Db,
  _config: Env,
  params: MarkConnectionNeedsReauthParams
): Promise<void> {
  const { workspaceId, provider, reason } = params;
  const at = new Date().toISOString();

  const [changed] = await db
    .update(crmConnections)
    .set({
      status: "needs_reauth",
      settings: sql`coalesce(${crmConnections.settings}, '{}'::jsonb) || ${JSON.stringify({ lastAuthError: reason, lastAuthErrorAt: at })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)), ne(crmConnections.status, "needs_reauth")))
    .returning({ id: crmConnections.id });

  if (!changed) return;
  const connectionId = params.connectionId ?? changed.id;

  log.warn("CRM connection marked needs_reauth", { workspaceId, provider, reason, connectionId });

  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
  try {
    await notifyCrmAdmins(db, {
      workspaceId,
      type: "crm_grant_expired",
      title: `${providerLabel} Reconnection Required`,
      body: `The authorization grant for ${providerLabel} has expired or was revoked. Please reconnect the integration in Settings to resume CRM sync.`,
      connectionId,
      dedupeKey: `grant:${connectionId}:${at}`,
    });
  } catch (err) {
    log.warn("Failed notifying admins of an expired CRM grant", { err, workspaceId, provider });
  }
}
