import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";

const { crmConnections, auditLogs } = schema;
const log = createLogger("crm-opt-in");

export interface CrmSyncOptInSettings {
  syncEnabled: boolean;
  accountScope?: string[];
  objectScope?: {
    contacts?: boolean;
    deals?: boolean;
  };
  pollIntervalMinutes?: number;
}

export const DEFAULT_CRM_OPT_IN_SETTINGS: CrmSyncOptInSettings = {
  syncEnabled: false,
  accountScope: ["*"],
  objectScope: {
    contacts: true,
    deals: true,
  },
  pollIntervalMinutes: 30,
};

/**
 * ADR 0014: External CRM sync is opt-in per workspace/account.
 * Sync is off by default unless explicitly enabled.
 */
export function isCrmSyncOptedIn(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const s = settings as Record<string, unknown>;
  if (typeof s.syncEnabled === "boolean") {
    return s.syncEnabled;
  }
  // Default to false per ADR 0014
  return false;
}

/**
 * Checks whether a specific external account ID is within the configured sync scope.
 */
export function isAccountInScope(settings: unknown, accountId?: string | null): boolean {
  if (!isCrmSyncOptedIn(settings)) return false;
  if (!accountId) return true;

  const s = settings as Record<string, unknown>;
  const scope = Array.isArray(s.accountScope) ? (s.accountScope as string[]) : ["*"];
  if (scope.includes("*") || scope.includes(accountId)) {
    return true;
  }
  return false;
}

export interface CrmSyncScope {
  enabled: boolean;
  contacts: boolean;
  deals: boolean;
  /** Skout company (account) ids, or ["*"] for every account. */
  accountScope: string[];
}

/** The opt-in state every sync path checks (ADR 0014); null when there is no connection. */
export async function getCrmSyncScope(db: Db, workspaceId: string, provider: string): Promise<CrmSyncScope | null> {
  const [connection] = await db
    .select({ settings: crmConnections.settings, status: crmConnections.status })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);
  if (!connection) return null;
  const s = (connection.settings ?? {}) as Record<string, any>;
  return {
    enabled: connection.status === "connected" && isCrmSyncOptedIn(s),
    contacts: s.objectScope?.contacts !== false,
    deals: s.objectScope?.deals !== false,
    accountScope: Array.isArray(s.accountScope) && s.accountScope.length > 0 ? (s.accountScope as string[]) : ["*"],
  };
}

/**
 * Whether a record of this account is in scope. With every account in scope, new records (no
 * account yet) are in scope too; with a limited scope only records of the listed accounts are.
 */
export function isCompanyInScope(scope: CrmSyncScope, companyId: string | null | undefined): boolean {
  if (scope.accountScope.includes("*")) return true;
  return Boolean(companyId && scope.accountScope.includes(companyId));
}

/**
 * Retrieves the current opt-in configuration for a CRM connection.
 */
export async function getCrmSyncOptIn(
  db: Db,
  workspaceId: string,
  provider: string
): Promise<CrmSyncOptInSettings> {
  const [connection] = await db
    .select({ settings: crmConnections.settings, status: crmConnections.status })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);

  if (!connection) {
    throw new Error(`CRM connection for ${provider} not found`);
  }

  const settings = (connection.settings ?? {}) as Record<string, unknown>;
  return {
    syncEnabled: typeof settings.syncEnabled === "boolean" ? settings.syncEnabled : false,
    accountScope: Array.isArray(settings.accountScope) ? (settings.accountScope as string[]) : ["*"],
    objectScope: {
      contacts: (settings.objectScope as any)?.contacts !== false,
      deals: (settings.objectScope as any)?.deals !== false,
    },
    pollIntervalMinutes:
      typeof settings.pollIntervalMinutes === "number" ? settings.pollIntervalMinutes : 30,
  };
}

/**
 * Updates the opt-in settings for a CRM connection and writes an audit log.
 */
export async function updateCrmSyncOptIn(
  db: Db,
  workspaceId: string,
  provider: string,
  optIn: Partial<CrmSyncOptInSettings>,
  actorId?: string
): Promise<CrmSyncOptInSettings> {
  const [connection] = await db
    .select({ id: crmConnections.id, settings: crmConnections.settings })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);

  if (!connection) {
    throw new Error(`CRM connection for ${provider} not found`);
  }

  const existingSettings = (connection.settings ?? {}) as Record<string, unknown>;
  const updatedOptIn: CrmSyncOptInSettings = {
    syncEnabled: typeof optIn.syncEnabled === "boolean" ? optIn.syncEnabled : (existingSettings.syncEnabled as boolean) ?? false,
    accountScope: optIn.accountScope ?? (existingSettings.accountScope as string[]) ?? ["*"],
    objectScope: {
      contacts: optIn.objectScope?.contacts ?? (existingSettings.objectScope as any)?.contacts ?? true,
      deals: optIn.objectScope?.deals ?? (existingSettings.objectScope as any)?.deals ?? true,
    },
    pollIntervalMinutes: optIn.pollIntervalMinutes ?? (existingSettings.pollIntervalMinutes as number) ?? 30,
  };

  const newSettings = {
    ...existingSettings,
    ...updatedOptIn,
    optInUpdatedAt: new Date().toISOString(),
  };

  await db
    .update(crmConnections)
    .set({
      settings: newSettings,
      updatedAt: new Date(),
    })
    .where(eq(crmConnections.id, connection.id));

  try {
    await db.insert(auditLogs).values({
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      action: "crm_connection.opt_in_updated",
      entityType: "crm_connection",
      entityId: connection.id,
      beforeState: { optIn: existingSettings },
      afterState: { optIn: updatedOptIn },
      reason: "CRM sync opt-in configuration updated",
    });
  } catch (auditErr) {
    log.warn("Failed recording audit log for opt-in update", { auditErr, connectionId: connection.id });
  }

  log.info("CRM sync opt-in settings updated", {
    workspaceId,
    provider,
    syncEnabled: updatedOptIn.syncEnabled,
  });

  return updatedOptIn;
}
