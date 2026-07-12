import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import {
  isUnipileConfigured,
  linkedinPublicIdentifierFromUrl,
  unipileCreateHostedAuthLink,
  unipileGetProfileBySlug,
  unipileSendInvitation,
  unipileStartChat,
  UnipileError,
} from "./unipile.client.js";

const { linkedinAccounts } = schema;

export class LinkedinAccountService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async list(workspaceId: string) {
    return this.db
      .select()
      .from(linkedinAccounts)
      .where(eq(linkedinAccounts.workspaceId, workspaceId))
      .orderBy(asc(linkedinAccounts.createdAt));
  }

  async connect(
    workspaceId: string,
    input: { unipileAccountId: string; displayName?: string; linkedinUrl?: string }
  ) {
    if (!isUnipileConfigured(this.config)) {
      throw new HttpError("LinkedIn sending is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const unipileAccountId = input.unipileAccountId.trim();
    if (!unipileAccountId) throw new HttpError("unipileAccountId is required", 400);

    const existing = await this.list(workspaceId);
    const [row] = await this.db
      .insert(linkedinAccounts)
      .values({
        workspaceId,
        unipileAccountId,
        displayName: input.displayName?.trim() || null,
        linkedinUrl: input.linkedinUrl?.trim() || null,
        status: "active",
        isDefault: existing.length === 0,
      })
      .onConflictDoUpdate({
        target: [linkedinAccounts.workspaceId, linkedinAccounts.unipileAccountId],
        set: {
          displayName: input.displayName?.trim() || null,
          linkedinUrl: input.linkedinUrl?.trim() || null,
          status: "active",
          updatedAt: new Date(),
          lastError: null,
        },
      })
      .returning();
    return row!;
  }

  async createHostedAuthLink(workspaceId: string, webBaseUrl: string) {
    if (!isUnipileConfigured(this.config)) {
      throw new HttpError("LinkedIn sending is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const base = webBaseUrl.replace(/\/$/, "");
    return unipileCreateHostedAuthLink(this.config, {
      successRedirectUrl: `${base}/deliverability?linkedin=connected`,
      failureRedirectUrl: `${base}/deliverability?linkedin=failed`,
      notifyUrl: undefined,
    });
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

  /** Round-robin: least recently used active account under daily limit. */
  async pickNextAccount(workspaceId: string) {
    const [account] = await this.db
      .select()
      .from(linkedinAccounts)
      .where(
        and(
          eq(linkedinAccounts.workspaceId, workspaceId),
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
  }
): Promise<{ externalId?: string }> {
  const slug = linkedinPublicIdentifierFromUrl(input.linkedinUrl);
  if (!slug) throw new UnipileError("invalid_linkedin_url", 400);

  const profile = await unipileGetProfileBySlug(config, account.unipileAccountId, slug);

  if (input.action === "connect") {
    await unipileSendInvitation(config, {
      accountId: account.unipileAccountId,
      providerId: profile.provider_id,
      message: input.message,
    });
    return { externalId: profile.provider_id };
  }

  if (!input.message?.trim()) {
    throw new UnipileError("linkedin_message_empty", 400);
  }
  await unipileStartChat(config, {
    accountId: account.unipileAccountId,
    providerId: profile.provider_id,
    text: input.message,
  });
  return { externalId: profile.provider_id };
}

export function buildLinkedinAccountService(db: Db | null | undefined, config: Env) {
  if (!db) return null;
  return new LinkedinAccountService(db, config);
}
