import { createLogger } from "@skout/observability";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { signOAuthState, verifyOAuthState } from "../utils/oauth-state.js";
import { enqueueCrmExportJob } from "../workers/crm-export.queue.js";
import { DbStore } from "./enrichment/db-store.js";
import { InsufficientCreditsError } from "./enrichment/types.js";
import {
  ensureFreshTokens,
  saveHubSpotTokens,
} from "./crm-export.runner.js";
import {
  buildHubSpotAuthorizeUrl,
  exchangeHubSpotCode,
  fetchAllHubSpotContacts,
  fetchHubSpotListContacts,
  isHubSpotMissingScopeError,
  searchHubSpotLists,
  type HubSpotContactProperties,
  type HubSpotListSummary,
} from "./hubspot.client.js";
import {
  createHubSpotCredentialsStore,
  type HubSpotCredentialsStore,
} from "./hubspot-credentials.store.js";
import { buildEnrichmentService, type ProspectSnapshot } from "./enrichment/index.js";
import { normalizeDomain, generateCompanyId, generateProspectId } from "@skout/shared";

const { crmConnections, asyncJobs, listMembers, lists, crmProspectMappings } = schema;

const HUBSPOT_PROVIDER = "hubspot";
const log = createLogger("crm.service");
const EXPORT_CREDIT_PER_CONTACT = 1;
const IMPORT_MAX_CONTACTS = 500;

function domainFromEmail(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[1].includes(".")) return null;
  return normalizeDomain(parts[1]);
}

function domainFromCompanyName(company: string): string {
  const slug = company
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}.hubspot-import` : "unknown.hubspot-import";
}

function prospectIdFromSnapshot(snap: ProspectSnapshot): string {
  return (
    snap.prospectId ??
    (snap.email
      ? generateProspectId(snap.companyDomain, snap.email)
      : generateCompanyId(`${snap.companyDomain}:${snap.fullName ?? ""}`))
  );
}

async function saveHubSpotImportMappings(
  db: Db,
  workspaceId: string,
  snapshots: ProspectSnapshot[]
): Promise<void> {
  for (const snap of snapshots) {
    if (!snap.hubspotContactId) continue;
    const prospectId = prospectIdFromSnapshot(snap);
    await db
      .insert(crmProspectMappings)
      .values({
        workspaceId,
        provider: HUBSPOT_PROVIDER,
        prospectId,
        externalId: snap.hubspotContactId,
      })
      .onConflictDoUpdate({
        target: [
          crmProspectMappings.workspaceId,
          crmProspectMappings.provider,
          crmProspectMappings.prospectId,
        ],
        set: {
          externalId: snap.hubspotContactId,
          updatedAt: new Date(),
        },
      });
  }
}

function displayNameFromEmail(email: string): string | undefined {
  const local = email.split("@")[0]?.trim();
  if (!local) return undefined;
  const words = local.replace(/[._+-]+/g, " ").trim();
  if (!words) return undefined;
  return words
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function hubSpotContactToSnapshot(contact: {
  id: string;
  properties: HubSpotContactProperties;
}): ProspectSnapshot | null {
  const props = contact.properties;
  const email = props.email?.trim().toLowerCase();
  const companyName = props.company?.trim() || undefined;
  const fullName =
    [props.firstname, props.lastname].filter(Boolean).join(" ").trim() ||
    (email ? displayNameFromEmail(email) : undefined) ||
    companyName;
  const companyDomain =
    (email ? domainFromEmail(email) : null) ??
    (companyName ? domainFromCompanyName(companyName) : null);

  if (!companyDomain) return null;

  return {
    prospectId: undefined,
    fullName,
    title: props.jobtitle?.trim() || undefined,
    companyDomain,
    companyName,
    email: email || undefined,
    phone: props.phone?.trim() || undefined,
    signals: ["hubspot_import"],
    hubspotContactId: contact.id,
  };
}

interface ConnectionRow {
  id: string;
  provider: string;
  status: string;
  externalAccountId: string | null;
  credentialsRef: string | null;
  connectedAt: Date;
  tokenExpiresAt: Date | null;
}

export class CrmService {
  private readonly credentialsStore: HubSpotCredentialsStore;

  constructor(
    private readonly db: Db | null,
    private readonly config: Env
  ) {
    this.credentialsStore = createHubSpotCredentialsStore(config);
  }

  private get oauthSecret(): string {
    return this.config.HUBSPOT_CLIENT_SECRET ?? this.config.CLERK_SECRET_KEY ?? "dev-oauth-state";
  }

  private get apiPublicUrl(): string {
    return (
      this.config.API_PUBLIC_URL ??
      process.env.API_PUBLIC_URL ??
      `http://localhost:${this.config.PORT}`
    );
  }

  private get frontendUrl(): string {
    return this.config.FRONTEND_URL ?? this.config.CORS_ORIGIN[0] ?? "http://localhost:3000";
  }

  private get redirectUri(): string {
    return `${this.apiPublicUrl.replace(/\/$/, "")}/api/v1/crm/hubspot/callback`;
  }

  private hubspotConfigured(): boolean {
    return Boolean(this.config.HUBSPOT_CLIENT_ID && this.config.HUBSPOT_CLIENT_SECRET);
  }

  async listConnections(workspaceId: string) {
    if (!this.db) {
      return { workspaceId, data: [], total: 0 };
    }
    const rows = await this.db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.workspaceId, workspaceId));
    const data = rows.map((r) => this.toConnectionDto(r as ConnectionRow));
    return { workspaceId, data, total: data.length };
  }

  getHubSpotConnectUrl(workspaceId: string): { authorizationUrl: string } {
    if (!this.hubspotConfigured()) {
      throw new HttpError("hubspot_not_configured", 503);
    }
    const state = signOAuthState({ workspaceId }, this.oauthSecret);
    return {
      authorizationUrl: buildHubSpotAuthorizeUrl({
        clientId: this.config.HUBSPOT_CLIENT_ID!,
        redirectUri: this.redirectUri,
        state,
      }),
    };
  }

  async handleHubSpotCallback(code: string, state: string): Promise<string> {
    if (!this.db) throw new HttpError("database_unavailable", 503);
    if (!this.hubspotConfigured()) throw new HttpError("hubspot_not_configured", 503);

    const parsed = verifyOAuthState(state, this.oauthSecret);
    if (!parsed?.workspaceId) throw new HttpError("invalid_oauth_state", 400);

    const tokens = await exchangeHubSpotCode({
      clientId: this.config.HUBSPOT_CLIENT_ID!,
      clientSecret: this.config.HUBSPOT_CLIENT_SECRET!,
      redirectUri: this.redirectUri,
      code,
    });

    const portalId = createHmac("sha256", this.oauthSecret)
      .update(tokens.accessToken)
      .digest("hex")
      .slice(0, 12);

    await saveHubSpotTokens(this.db, this.credentialsStore, parsed.workspaceId, tokens, portalId);
    return `${this.frontendUrl.replace(/\/$/, "")}/settings/crm?hubspot=connected`;
  }

  async disconnectHubSpot(workspaceId: string): Promise<void> {
    if (!this.db) throw new HttpError("database_unavailable", 503);

    const connection = await this.getHubSpotConnection(workspaceId);
    if (connection?.credentialsRef) {
      await this.credentialsStore.delete(connection.credentialsRef);
    }

    await this.db
      .delete(crmConnections)
      .where(
        and(eq(crmConnections.workspaceId, workspaceId), eq(crmConnections.provider, HUBSPOT_PROVIDER))
      );
  }

  async listHubSpotLists(workspaceId: string): Promise<{ data: HubSpotListSummary[]; total: number }> {
    if (!this.db) throw new HttpError("database_unavailable", 503);
    await this.requireHubSpotConnected(workspaceId);
    const tokens = await ensureFreshTokens(this.db, this.config, this.credentialsStore, workspaceId);
    try {
      const data = await searchHubSpotLists(tokens.accessToken);
      return { data, total: data.length };
    } catch (err) {
      if (isHubSpotMissingScopeError(err)) {
        throw new HttpError("hubspot_lists_scope_missing", 403, {
          scope: "crm.lists.read",
          hint: "Disconnect HubSpot in Skout, run hs project upload, then connect again.",
        });
      }
      throw err;
    }
  }

  async importFromHubSpot(
    workspaceId: string,
    options: {
      source: "all" | "list";
      hubspotListId?: string;
      targetListId?: string;
      newListName?: string;
      maxContacts?: number;
    }
  ): Promise<{ listId: string; imported: number; skipped: number; source: string }> {
    if (!this.db) throw new HttpError("database_unavailable", 503);
    await this.requireHubSpotConnected(workspaceId);

    const maxContacts = Math.min(options.maxContacts ?? IMPORT_MAX_CONTACTS, IMPORT_MAX_CONTACTS);
    const tokens = await ensureFreshTokens(this.db, this.config, this.credentialsStore, workspaceId);

    const rawContacts =
      options.source === "list"
        ? await (async () => {
            if (!options.hubspotListId) throw new HttpError("hubspot_list_required", 400);
            return fetchHubSpotListContacts(tokens.accessToken, options.hubspotListId, maxContacts);
          })()
        : await fetchAllHubSpotContacts(tokens.accessToken, maxContacts);

    const snapshots: ProspectSnapshot[] = [];
    let skipped = 0;
    for (const contact of rawContacts) {
      const snap = hubSpotContactToSnapshot(contact);
      if (!snap) {
        skipped += 1;
        continue;
      }
      snapshots.push(snap);
    }

    if (!snapshots.length) {
      throw new HttpError("hubspot_import_empty", 400, { skipped, fetched: rawContacts.length });
    }

    const enrich = buildEnrichmentService(this.db, this.config);
    let listId = options.targetListId;

    if (options.newListName?.trim()) {
      const created = await enrich.createList(workspaceId, options.newListName.trim(), snapshots);
      listId = created.id;
    } else if (listId) {
      const updated = await enrich.addListMembers(workspaceId, listId, snapshots);
      if (!updated) throw new HttpError("list_not_found", 404);
    } else {
      throw new HttpError("import_target_required", 400);
    }

    await saveHubSpotImportMappings(this.db, workspaceId, snapshots);

    return {
      listId: listId!,
      imported: snapshots.length,
      skipped,
      source: options.source === "list" ? `list:${options.hubspotListId}` : "all",
    };
  }

  async startHubSpotListExport(workspaceId: string, listId: string): Promise<{ jobId: string }> {
    if (!this.db) throw new HttpError("database_unavailable", 503);

    const connection = await this.getHubSpotConnection(workspaceId);
    if (!connection || connection.status !== "connected") {
      throw new HttpError("hubspot_not_connected", 400);
    }

    const [list] = await this.db
      .select()
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)));
    if (!list) throw new HttpError("list_not_found", 404);

    const members = await this.db.select().from(listMembers).where(eq(listMembers.listId, listId));
    const contactCount = members.length;
    if (!contactCount) throw new HttpError("list_empty", 400);

    const store = new DbStore(this.db);
    const creditCost = contactCount * EXPORT_CREDIT_PER_CONTACT;
    try {
      await store.deductCredits(workspaceId, creditCost, "export_hubspot", listId);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        throw new HttpError("insufficient_credits", 402, {
          required: err.required,
          available: err.available,
        });
      }
      throw err;
    }

    const [job] = await this.db
      .insert(asyncJobs)
      .values({
        workspaceId,
        jobType: "crm_sync",
        status: "pending",
        entityType: "list",
        entityId: listId,
        payload: { listId, provider: HUBSPOT_PROVIDER, contactCount },
      })
      .returning();

    try {
      await enqueueCrmExportJob(this.config, {
        jobId: job.id,
        workspaceId,
        listId,
      });
    } catch (err) {
      log.error("Failed to enqueue HubSpot export — rolling back job", err, { jobId: job.id });
      await this.db
        .update(asyncJobs)
        .set({
          status: "failed",
          errorMessage: "queue_unavailable",
          completedAt: new Date(),
        })
        .where(eq(asyncJobs.id, job.id));
      throw new HttpError("export_queue_unavailable", 503);
    }

    return { jobId: job.id };
  }

  async getExportJob(workspaceId: string, jobId: string) {
    if (!this.db) throw new HttpError("database_unavailable", 503);
    const [job] = await this.db
      .select()
      .from(asyncJobs)
      .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.workspaceId, workspaceId)));
    if (!job) throw new HttpError("job_not_found", 404);
    return {
      id: job.id,
      jobType: job.jobType,
      status: job.status,
      entityType: job.entityType,
      entityId: job.entityId,
      result: job.result,
      errorMessage: job.errorMessage,
      queuedAt: job.queuedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }

  private async requireHubSpotConnected(workspaceId: string): Promise<void> {
    const connection = await this.getHubSpotConnection(workspaceId);
    if (!connection || connection.status !== "connected") {
      throw new HttpError("hubspot_not_connected", 400);
    }
  }

  private async getHubSpotConnection(workspaceId: string): Promise<ConnectionRow | null> {
    if (!this.db) return null;
    const [row] = await this.db
      .select()
      .from(crmConnections)
      .where(
        and(eq(crmConnections.workspaceId, workspaceId), eq(crmConnections.provider, HUBSPOT_PROVIDER))
      );
    return (row as ConnectionRow) ?? null;
  }

  private toConnectionDto(row: ConnectionRow) {
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      externalAccountId: row.externalAccountId,
      connectedAt: row.connectedAt.toISOString(),
      tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    };
  }
}

export function createCrmService(db: Db | null, config: Env): CrmService {
  return new CrmService(db, config);
}
