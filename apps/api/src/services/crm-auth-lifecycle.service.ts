import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { createNotification } from "./notifications.service.js";
import { getCopsNotificationRecipients } from "./cops-notification-routing.js";

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
 * Marks a CRM connection as 'needs_reauth' and raises in-app alerts to workspace admins/owners.
 * Used when refresh tokens are rejected, grants are revoked by user in provider, or 401 Unauthorized
 * indicates authorization has expired.
 */
export async function markConnectionNeedsReauth(
  db: Db,
  config: Env,
  params: MarkConnectionNeedsReauthParams
): Promise<void> {
  const { workspaceId, provider, reason } = params;

  // 1. Fetch current connection row to preserve existing settings
  const [existing] = await db
    .select({
      id: crmConnections.id,
      settings: crmConnections.settings,
      status: crmConnections.status,
    })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);

  const connectionId = params.connectionId ?? existing?.id ?? null;
  const currentSettings = (existing?.settings ?? {}) as Record<string, unknown>;

  // 2. Update status to 'needs_reauth' and persist error info in settings
  await db
    .update(crmConnections)
    .set({
      status: "needs_reauth",
      settings: {
        ...currentSettings,
        lastAuthError: reason,
        lastAuthErrorAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)));

  log.warn("CRM connection marked needs_reauth", {
    workspaceId,
    provider,
    reason,
    connectionId,
  });

  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
  const title = `${providerLabel} Reconnection Required`;
  const body = `The authorization grant for ${providerLabel} has expired or was revoked. Please reconnect the integration in Settings to resume CRM sync.`;

  // 3. Workspace-wide in-app notification (userId: null)
  try {
    await createNotification(db, config, {
      workspaceId,
      userId: null,
      type: "crm_grant_expired",
      title,
      body,
      entityType: "crm_connection",
      entityId: connectionId,
    });
  } catch (err) {
    log.warn("Failed creating workspace notification for expired CRM grant", { err, workspaceId, provider });
  }

  // 4. Targeted in-app notifications to admin/owner roles
  try {
    const adminRecipients = await getCopsNotificationRecipients(db, workspaceId, ["admin", "owner"]);
    for (const userId of adminRecipients) {
      await createNotification(db, config, {
        workspaceId,
        userId,
        type: "crm_grant_expired",
        title,
        body,
        entityType: "crm_connection",
        entityId: connectionId,
      }).catch((err) => {
        log.warn("Failed creating user notification for expired CRM grant", { err, userId, workspaceId });
      });
    }
  } catch (err) {
    log.warn("Failed fetching admin recipients for expired CRM grant", { err, workspaceId });
  }
}

