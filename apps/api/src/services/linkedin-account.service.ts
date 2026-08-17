import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import {
  isUnipileConfigured,
  linkedinPublicIdentifierFromUrl,
  normalizeWhatsappAttendeeId,
  unipileCreateHostedAuthLink,
  unipileGetProfileBySlug,
  unipileListAccounts,
  unipileSendInvitation,
  unipileSendWhatsapp,
  unipileStartChat,
  UnipileError,
  type UnipileAccount,
  type UnipileProvider,
} from "./unipile.client.js";
import { createIntegrationService } from "./integration.service.js";
import { DEFAULT_UNIPILE_DSN } from "./integration-providers.js";

const { linkedinAccounts } = schema;

export type MessagingChannel = "linkedin" | "whatsapp";

function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export class LinkedinAccountService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  /** Prefer workspace Unipile BYOK; fall back to platform env. */
  async resolveConfig(workspaceId: string): Promise<Env> {
    const integrations = createIntegrationService(this.db, this.config);
    const creds = await integrations.loadWorkspaceUnipileCredentials(workspaceId);
    if (!creds) return this.config;
    return {
      ...this.config,
      UNIPILE_API_KEY: creds.apiKey,
      UNIPILE_DSN: creds.dsn || this.config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN,
    };
  }

  async isConfiguredForWorkspace(workspaceId: string): Promise<boolean> {
    const cfg = await this.resolveConfig(workspaceId);
    return isUnipileConfigured(cfg);
  }

  async list(workspaceId: string, channel?: MessagingChannel) {
    const conditions = [eq(linkedinAccounts.workspaceId, workspaceId)];
    if (channel) conditions.push(eq(linkedinAccounts.channel, channel));
    return this.db
      .select()
      .from(linkedinAccounts)
      .where(and(...conditions))
      .orderBy(asc(linkedinAccounts.createdAt));
  }

  async connect(
    workspaceId: string,
    input: {
      unipileAccountId: string;
      displayName?: string;
      linkedinUrl?: string;
      phone?: string;
      channel?: MessagingChannel;
    }
  ) {
    if (!(await this.isConfiguredForWorkspace(workspaceId))) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const unipileAccountId = input.unipileAccountId.trim();
    if (!unipileAccountId) throw new HttpError("unipileAccountId is required", 400);
    const channel: MessagingChannel = input.channel === "whatsapp" ? "whatsapp" : "linkedin";

    const existing = await this.list(workspaceId, channel);
    const [row] = await this.db
      .insert(linkedinAccounts)
      .values({
        workspaceId,
        unipileAccountId,
        channel,
        displayName: input.displayName?.trim() || null,
        linkedinUrl: input.linkedinUrl?.trim() || null,
        phone: input.phone?.trim() || null,
        status: "active",
        isDefault: existing.length === 0,
        dailySendLimit: channel === "whatsapp" ? 80 : 40,
      })
      .onConflictDoUpdate({
        target: [linkedinAccounts.workspaceId, linkedinAccounts.unipileAccountId],
        set: {
          channel,
          displayName: input.displayName?.trim() || null,
          linkedinUrl: input.linkedinUrl?.trim() || null,
          phone: input.phone?.trim() || null,
          status: "active",
          updatedAt: new Date(),
          lastError: null,
        },
      })
      .returning();
    return row!;
  }

  async createHostedAuthLink(
    workspaceId: string,
    webBaseUrl: string,
    providers: UnipileProvider[] = ["LINKEDIN"]
  ) {
    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const base = webBaseUrl.replace(/\/$/, "");
    const apiBase = (cfg.API_PUBLIC_URL || cfg.FRONTEND_URL || "").replace(/\/$/, "");
    const channelHint = providers.includes("WHATSAPP") && !providers.includes("LINKEDIN") ? "whatsapp" : "linkedin";
    // Unipile must reach notify_url from the public internet — localhost never works.
    const notifyUrl =
      apiBase && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(apiBase)
        ? `${apiBase}/api/v1/webhooks/unipile/hosted-auth?workspaceId=${encodeURIComponent(workspaceId)}`
        : undefined;
    return unipileCreateHostedAuthLink(cfg, {
      successRedirectUrl: `${base}/deliverability?${channelHint}=connected`,
      failureRedirectUrl: `${base}/deliverability?${channelHint}=failed`,
      notifyUrl,
      providers,
    });
  }

  /**
   * Import Unipile-connected accounts into this workspace.
   * Needed locally (and as a fallback) when notify_url webhooks cannot reach the API.
   */
  async syncFromUnipile(workspaceId: string, channel?: MessagingChannel) {
    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const remote = await unipileListAccounts(cfg);
    const imported = [];
    for (const acc of remote) {
      const mapped = mapUnipileAccountChannel(acc);
      if (!mapped) continue;
      if (channel && mapped !== channel) continue;
      imported.push(
        await this.connect(workspaceId, {
          unipileAccountId: acc.id,
          displayName: acc.name?.trim() || undefined,
          channel: mapped,
        })
      );
    }
    return { imported, total: imported.length };
  }

  async setStatus(workspaceId: string, id: string, status: "active" | "paused") {
    const [row] = await this.db
      .update(linkedinAccounts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(linkedinAccounts.id, id), eq(linkedinAccounts.workspaceId, workspaceId)))
      .returning();
    return row ?? null;
  }

  async disconnect(workspaceId: string, id: string) {
    await this.db
      .delete(linkedinAccounts)
      .where(and(eq(linkedinAccounts.id, id), eq(linkedinAccounts.workspaceId, workspaceId)));
  }

  /** Reset daily counters when the UTC day rolls over, then pick least-recently-used account. */
  async pickNextAccount(workspaceId: string, channel: MessagingChannel = "linkedin") {
    const dayStart = startOfUtcDay();
    await this.db
      .update(linkedinAccounts)
      .set({ sentCount: 0, updatedAt: new Date() })
      .where(
        and(
          eq(linkedinAccounts.workspaceId, workspaceId),
          eq(linkedinAccounts.channel, channel),
          sql`(${linkedinAccounts.lastUsedAt} is null or ${linkedinAccounts.lastUsedAt} < ${dayStart})`,
          sql`${linkedinAccounts.sentCount} > 0`
        )
      );

    const [account] = await this.db
      .select()
      .from(linkedinAccounts)
      .where(
        and(
          eq(linkedinAccounts.workspaceId, workspaceId),
          eq(linkedinAccounts.channel, channel),
          eq(linkedinAccounts.status, "active"),
          sql`${linkedinAccounts.sentCount} < ${linkedinAccounts.dailySendLimit}`
        )
      )
      .orderBy(
        sql`case when ${linkedinAccounts.lastUsedAt} is null then 0 else 1 end`,
        asc(linkedinAccounts.lastUsedAt)
      )
      .limit(1);
    return account ?? null;
  }

  async markUsed(accountId: string) {
    await this.db
      .update(linkedinAccounts)
      .set({
        lastUsedAt: new Date(),
        sentCount: sql`${linkedinAccounts.sentCount} + 1`,
        updatedAt: new Date(),
        lastError: null,
      })
      .where(eq(linkedinAccounts.id, accountId));
  }

  async markError(accountId: string, error: string) {
    await this.db
      .update(linkedinAccounts)
      .set({ lastError: error.slice(0, 500), updatedAt: new Date() })
      .where(eq(linkedinAccounts.id, accountId));
  }
}

export async function sendLinkedinOutreach(
  config: Env,
  account: { id: string; unipileAccountId: string },
  input: {
    action: "connect" | "message";
    linkedinUrl: string;
    message: string | null;
  },
  workspaceId?: string,
  db?: Db
): Promise<{ externalId?: string }> {
  let effective = config;
  if (workspaceId && db) {
    const integrations = createIntegrationService(db, config);
    const creds = await integrations.loadWorkspaceUnipileCredentials(workspaceId);
    if (creds) {
      effective = {
        ...config,
        UNIPILE_API_KEY: creds.apiKey,
        UNIPILE_DSN: creds.dsn || config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN,
      };
    }
  }

  const slug = linkedinPublicIdentifierFromUrl(input.linkedinUrl);
  if (!slug) throw new UnipileError("invalid_linkedin_url", 400);

  const profile = await unipileGetProfileBySlug(effective, account.unipileAccountId, slug);

  if (input.action === "connect") {
    await unipileSendInvitation(effective, {
      accountId: account.unipileAccountId,
      providerId: profile.provider_id,
      message: input.message,
    });
    return { externalId: profile.provider_id };
  }

  if (!input.message?.trim()) {
    throw new UnipileError("linkedin_message_empty", 400);
  }
  await unipileStartChat(effective, {
    accountId: account.unipileAccountId,
    providerId: profile.provider_id,
    text: input.message,
  });
  return { externalId: profile.provider_id };
}

export async function sendWhatsappOutreach(
  config: Env,
  account: { id: string; unipileAccountId: string },
  input: { phone: string; message: string },
  workspaceId?: string,
  db?: Db
): Promise<{ externalId?: string }> {
  let effective = config;
  if (workspaceId && db) {
    const integrations = createIntegrationService(db, config);
    const creds = await integrations.loadWorkspaceUnipileCredentials(workspaceId);
    if (creds) {
      effective = {
        ...config,
        UNIPILE_API_KEY: creds.apiKey,
        UNIPILE_DSN: creds.dsn || config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN,
      };
    }
  }

  const attendeeId = normalizeWhatsappAttendeeId(input.phone);
  if (!attendeeId) throw new UnipileError("invalid_whatsapp_phone", 400);
  if (!input.message?.trim()) throw new UnipileError("whatsapp_message_empty", 400);

  await unipileSendWhatsapp(effective, {
    accountId: account.unipileAccountId,
    attendeeId,
    text: input.message,
  });
  return { externalId: attendeeId };
}

function mapUnipileAccountChannel(acc: UnipileAccount): MessagingChannel | null {
  const raw = String(acc.type ?? acc.provider ?? "").toUpperCase();
  if (raw.includes("WHATSAPP")) return "whatsapp";
  if (raw.includes("LINKEDIN")) return "linkedin";
  return null;
}

export function buildLinkedinAccountService(db: Db | null | undefined, config: Env) {
  if (!db) return null;
  return new LinkedinAccountService(db, config);
}
