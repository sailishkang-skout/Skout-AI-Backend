import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { signOAuthState, verifyOAuthState } from "../utils/oauth-state.js";
import { DbStore } from "./enrichment/db-store.js";
import { InsufficientCreditsError } from "./enrichment/types.js";
import {
  batchCreateHubSpotContacts,
  buildHubSpotAuthorizeUrl,
  exchangeHubSpotCode,
  refreshHubSpotToken,
  type HubSpotContactInput,
  type HubSpotTokens,
} from "./hubspot.client.js";

const { crmConnections, asyncJobs, prospectActivations, listMembers, lists } = schema;

const HUBSPOT_PROVIDER = "hubspot";
const EXPORT_CREDIT_PER_CONTACT = 1;

interface ConnectionRow {
  id: string;
  provider: string;
  status: string;
  externalAccountId: string | null;
  settings: Record<string, unknown>;
  connectedAt: Date;
  tokenExpiresAt: Date | null;
}

export class CrmService {
  constructor(
    private readonly db: Db | null,
    private readonly config: Env
  ) {}

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

    await this.saveHubSpotConnection(parsed.workspaceId, tokens);
    return `${this.frontendUrl.replace(/\/$/, "")}/settings/crm?hubspot=connected`;
  }

  async disconnectHubSpot(workspaceId: string): Promise<void> {
    if (!this.db) throw new HttpError("database_unavailable", 503);
    await this.db
      .delete(crmConnections)
      .where(
        and(eq(crmConnections.workspaceId, workspaceId), eq(crmConnections.provider, HUBSPOT_PROVIDER))
      );
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

    void this.runHubSpotExport(job.id, workspaceId, listId).catch((err) => {
      console.error("HubSpot export failed", err);
    });

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

  private async runHubSpotExport(jobId: string, workspaceId: string, listId: string): Promise<void> {
    if (!this.db) return;

    await this.db
      .update(asyncJobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(asyncJobs.id, jobId));

    try {
      const tokens = await this.ensureFreshTokens(workspaceId);
      const members = await this.db.select().from(listMembers).where(eq(listMembers.listId, listId));
      const contacts: HubSpotContactInput[] = [];

      for (const member of members) {
        const [activation] = await this.db
          .select()
          .from(prospectActivations)
          .where(
            and(
              eq(prospectActivations.workspaceId, workspaceId),
              eq(prospectActivations.prospectId, member.prospectId)
            )
          );
        const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;
        const fullName = typeof snap.fullName === "string" ? snap.fullName : "";
        const parts = fullName.trim().split(/\s+/);
        const firstname = parts[0] ?? "";
        const lastname = parts.slice(1).join(" ") || undefined;
        contacts.push({
          prospectId: member.prospectId,
          email: typeof snap.email === "string" ? snap.email : undefined,
          firstname: firstname || undefined,
          lastname,
          company:
            typeof snap.companyDomain === "string"
              ? snap.companyDomain
              : typeof snap.company === "string"
                ? snap.company
                : undefined,
          jobtitle: typeof snap.title === "string" ? snap.title : undefined,
        });
      }

      const withEmail = contacts.filter((c) => c.email);
      const batchResult = await batchCreateHubSpotContacts(tokens.accessToken, withEmail);

      await this.db
        .update(asyncJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          result: {
            total: contacts.length,
            pushed: batchResult.created,
            skippedNoEmail: contacts.length - withEmail.length,
            errors: batchResult.errors,
          },
        })
        .where(eq(asyncJobs.id, jobId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(asyncJobs)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: message,
        })
        .where(eq(asyncJobs.id, jobId));
    }
  }

  private async ensureFreshTokens(workspaceId: string): Promise<HubSpotTokens> {
    const row = await this.getHubSpotConnection(workspaceId);
    if (!row) throw new HttpError("hubspot_not_connected", 400);

    const settings = row.settings as unknown as HubSpotTokens;
    const expiresAt = settings.expiresAt ? new Date(settings.expiresAt).getTime() : 0;
    if (expiresAt > Date.now() + 60_000) {
      return settings;
    }

    if (!this.hubspotConfigured() || !settings.refreshToken) {
      await this.markConnectionError(workspaceId);
      throw new HttpError("hubspot_token_expired", 401);
    }

    const refreshed = await refreshHubSpotToken({
      clientId: this.config.HUBSPOT_CLIENT_ID!,
      clientSecret: this.config.HUBSPOT_CLIENT_SECRET!,
      refreshToken: settings.refreshToken,
    });

    await this.saveHubSpotConnection(workspaceId, refreshed, row.externalAccountId);
    return refreshed;
  }

  private async saveHubSpotConnection(
    workspaceId: string,
    tokens: HubSpotTokens,
    externalAccountId?: string | null
  ): Promise<void> {
    if (!this.db) return;
    const portalId =
      externalAccountId ??
      createHmac("sha256", this.oauthSecret).update(tokens.accessToken).digest("hex").slice(0, 12);

    await this.db
      .insert(crmConnections)
      .values({
        workspaceId,
        provider: HUBSPOT_PROVIDER,
        status: "connected",
        externalAccountId: portalId,
        settings: tokens,
        tokenExpiresAt: new Date(tokens.expiresAt),
      })
      .onConflictDoUpdate({
        target: [crmConnections.workspaceId, crmConnections.provider],
        set: {
          status: "connected",
          externalAccountId: portalId,
          settings: tokens,
          tokenExpiresAt: new Date(tokens.expiresAt),
          updatedAt: new Date(),
        },
      });
  }

  private async markConnectionError(workspaceId: string): Promise<void> {
    if (!this.db) return;
    await this.db
      .update(crmConnections)
      .set({ status: "error", updatedAt: new Date() })
      .where(
        and(eq(crmConnections.workspaceId, workspaceId), eq(crmConnections.provider, HUBSPOT_PROVIDER))
      );
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
