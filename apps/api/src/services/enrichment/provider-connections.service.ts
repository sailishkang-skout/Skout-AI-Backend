import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { recordPrivilegedAction } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../../config/env.js";
import { createIntegrationService } from "../integration.service.js";
import { DEFAULT_UNIPILE_DSN } from "../integration-providers.js";
import { isUnipileConfigured, unipileListAccounts, UnipileError, type UnipileAccount } from "../unipile.client.js";
import { CaptureError, type CaptureActor } from "./capture-ingest.service.js";
import { providerPermission, type EnrichmentProviderId, type ProviderPermission } from "./provider-policy.js";

/**
 * ENR-04 — provider connections for background enrichment.
 *
 * A connection is the pair (provider account id, reference to a server-side credential). The
 * credential itself stays where it already lives — encrypted in `workspace_integrations`, or in
 * server configuration — and is only read inside the worker. Nothing in this module returns a
 * secret, a key hint or a decrypted value.
 */

const log = createLogger("enrichment.provider-connections");
const { enrichmentProviderConnections } = schema;

type ConnectionRow = typeof enrichmentProviderConnections.$inferSelect;
export type CredentialSource = "workspace" | "platform";

export interface ProviderConnectionDto {
  id: string;
  provider: string;
  externalAccountId: string;
  status: "active" | "paused" | "revoked";
  /** Whose credential the connection uses. Never the credential. */
  credentialSource: CredentialSource;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedProviderCredential {
  apiKey: string;
  baseUrl: string;
  source: CredentialSource;
}

/** Looks the provider's accounts up with a resolved credential. Replaceable in tests. */
export type AccountLister = (credential: ResolvedProviderCredential) => Promise<UnipileAccount[]>;

const credentialRefFor = (source: CredentialSource, provider: EnrichmentProviderId) =>
  source === "workspace" ? `workspace_integration:${provider}` : `platform:${provider}`;

function sourceOf(credentialRef: string): CredentialSource {
  return credentialRef.startsWith("workspace_integration:") ? "workspace" : "platform";
}

function toDto(row: ConnectionRow): ProviderConnectionDto {
  return {
    id: row.id,
    provider: row.provider,
    externalAccountId: row.externalAccountId,
    status: row.status as ProviderConnectionDto["status"],
    credentialSource: sourceOf(row.credentialRef),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function defaultAccountLister(config: Env): AccountLister {
  return (credential) =>
    unipileListAccounts({ ...config, UNIPILE_API_KEY: credential.apiKey, UNIPILE_DSN: credential.baseUrl });
}

/**
 * Resolves the credential a reference points at. Returns null when the referenced secret is
 * missing — a removed workspace key, or a platform key that is no longer configured.
 */
export async function resolveCredentialRef(
  db: Db,
  config: Env,
  workspaceId: string,
  credentialRef: string
): Promise<ResolvedProviderCredential | null> {
  const [kind, provider] = credentialRef.split(":");
  if (provider !== "unipile") return null;
  if (kind === "workspace_integration") {
    const creds = await createIntegrationService(db, config).loadWorkspaceUnipileCredentials(workspaceId);
    if (!creds?.apiKey) return null;
    return { apiKey: creds.apiKey, baseUrl: creds.dsn || config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN, source: "workspace" };
  }
  if (kind === "platform") {
    if (!isUnipileConfigured(config)) return null;
    return { apiKey: config.UNIPILE_API_KEY!, baseUrl: config.UNIPILE_DSN!, source: "platform" };
  }
  return null;
}

/** The workspace's own key when it has one, otherwise the platform key. */
async function resolveBestCredential(
  db: Db,
  config: Env,
  workspaceId: string
): Promise<{ credential: ResolvedProviderCredential; credentialRef: string } | null> {
  for (const source of ["workspace", "platform"] as const) {
    const credentialRef = credentialRefFor(source, "unipile");
    const credential = await resolveCredentialRef(db, config, workspaceId, credentialRef);
    if (credential) return { credential, credentialRef };
  }
  return null;
}

async function findAccount(lister: AccountLister, credential: ResolvedProviderCredential, externalAccountId: string) {
  let accounts: UnipileAccount[];
  try {
    accounts = await lister(credential);
  } catch (error) {
    if (error instanceof UnipileError && (error.status === 401 || error.status === 403)) {
      throw new CaptureError("provider_credential_rejected", 409, "The provider rejected the stored credential. Update it under Settings → Integrations.");
    }
    throw new CaptureError("provider_unreachable", 502, "The provider could not be reached to check this account. Try again shortly.");
  }
  return accounts.find((account) => account.id === externalAccountId) ?? null;
}

const isLinkedinAccount = (account: UnipileAccount) => (account.type ?? account.provider ?? "").toUpperCase() === "LINKEDIN";

export async function listProviderConnections(db: Db, workspaceId: string): Promise<ProviderConnectionDto[]> {
  const rows = await db
    .select()
    .from(enrichmentProviderConnections)
    .where(eq(enrichmentProviderConnections.workspaceId, workspaceId))
    .orderBy(desc(enrichmentProviderConnections.updatedAt));
  return rows.map(toDto);
}

/** The connection a new job should use: the most recently updated active one. */
export async function activeProviderConnection(db: Db, workspaceId: string, provider: EnrichmentProviderId): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(enrichmentProviderConnections)
    .where(
      and(
        eq(enrichmentProviderConnections.workspaceId, workspaceId),
        eq(enrichmentProviderConnections.provider, provider),
        eq(enrichmentProviderConnections.status, "active")
      )
    )
    .orderBy(desc(enrichmentProviderConnections.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function getProviderConnection(db: Db, workspaceId: string, id: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(enrichmentProviderConnections)
    .where(and(eq(enrichmentProviderConnections.workspaceId, workspaceId), eq(enrichmentProviderConnections.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Connects a Unipile LinkedIn account for enrichment. The account must exist under the
 * credential the server already holds; the caller supplies an account id and nothing else.
 */
export async function connectUnipileAccount(
  db: Db,
  config: Env,
  actor: CaptureActor,
  input: { externalAccountId: string },
  deps: { lister?: AccountLister; permission?: (config: Env) => ProviderPermission } = {}
): Promise<ProviderConnectionDto> {
  const lister = deps.lister ?? defaultAccountLister(config);
  const permission = (deps.permission ?? ((cfg: Env) => providerPermission(cfg, "unipile")))(config);
  if (!permission.permitted) throw new CaptureError("provider_not_permitted", 409, permission.reason!);

  const resolved = await resolveBestCredential(db, config, actor.workspaceId);
  if (!resolved) {
    throw new CaptureError("provider_credential_required", 409, "Add the Unipile API key under Settings → Integrations before connecting an account.");
  }
  const externalAccountId = input.externalAccountId.trim();
  const account = await findAccount(lister, resolved.credential, externalAccountId);
  if (!account) {
    throw new CaptureError("provider_account_not_found", 404, "No account with this id exists under the stored Unipile credential.");
  }
  if (!isLinkedinAccount(account)) {
    throw new CaptureError("provider_account_not_linkedin", 400, "This Unipile account is not a LinkedIn account.");
  }

  const now = new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(enrichmentProviderConnections)
      .values({
        workspaceId: actor.workspaceId,
        provider: "unipile",
        externalAccountId,
        credentialRef: resolved.credentialRef,
        status: "active",
        capabilities: { personProfile: true, companyProfile: true },
        lastCheckedAt: now,
        connectedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: [
          enrichmentProviderConnections.workspaceId,
          enrichmentProviderConnections.provider,
          enrichmentProviderConnections.externalAccountId,
        ],
        set: { credentialRef: resolved.credentialRef, status: "active", lastCheckedAt: now, lastErrorCode: null, updatedAt: now },
      })
      .returning();
    await recordPrivilegedAction(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "enrichment.provider_connection.connect",
      entityType: "enrichment_provider_connection",
      entityId: row!.id,
      afterState: { provider: "unipile", externalAccountId, credentialSource: resolved.credential.source, status: "active" },
    });
    log.info("provider connection connected", { workspaceId: actor.workspaceId, connectionId: row!.id, provider: "unipile" });
    return toDto(row!);
  });
}

/** Disconnects: the row is kept so past jobs still name their connection, but it is never used again. */
export async function disconnectProviderConnection(db: Db, actor: CaptureActor, id: string): Promise<ProviderConnectionDto | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(enrichmentProviderConnections)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(and(eq(enrichmentProviderConnections.workspaceId, actor.workspaceId), eq(enrichmentProviderConnections.id, id)))
      .returning();
    if (!row) return null;
    await recordPrivilegedAction(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "enrichment.provider_connection.disconnect",
      entityType: "enrichment_provider_connection",
      entityId: row.id,
      afterState: { provider: row.provider, externalAccountId: row.externalAccountId, status: "revoked" },
    });
    log.info("provider connection disconnected", { workspaceId: actor.workspaceId, connectionId: row.id });
    return toDto(row);
  });
}

/** Re-checks that the credential still resolves and the account is still there. */
export async function checkProviderConnection(
  db: Db,
  config: Env,
  actor: CaptureActor,
  id: string,
  lister: AccountLister = defaultAccountLister(config)
): Promise<ProviderConnectionDto | null> {
  const connection = await getProviderConnection(db, actor.workspaceId, id);
  if (!connection) return null;
  if (connection.status === "revoked") return toDto(connection);

  let errorCode: string | null = null;
  const credential = await resolveCredentialRef(db, config, actor.workspaceId, connection.credentialRef);
  if (!credential) {
    errorCode = "provider_credential_required";
  } else {
    try {
      if (!(await findAccount(lister, credential, connection.externalAccountId))) errorCode = "provider_account_not_found";
    } catch (error) {
      if (!(error instanceof CaptureError)) throw error;
      errorCode = error.code;
    }
  }
  const [row] = await db
    .update(enrichmentProviderConnections)
    .set({ lastCheckedAt: new Date(), lastErrorCode: errorCode, updatedAt: new Date() })
    .where(and(eq(enrichmentProviderConnections.workspaceId, actor.workspaceId), eq(enrichmentProviderConnections.id, id)))
    .returning();
  return row ? toDto(row) : null;
}

/** Records, from the worker, that the provider turned a connection's credential or account away. */
export async function markConnectionError(db: Db, workspaceId: string, id: string, errorCode: string): Promise<void> {
  await db
    .update(enrichmentProviderConnections)
    .set({ lastCheckedAt: new Date(), lastErrorCode: errorCode, updatedAt: new Date() })
    .where(and(eq(enrichmentProviderConnections.workspaceId, workspaceId), eq(enrichmentProviderConnections.id, id)));
}
