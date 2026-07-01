import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { encryptSecret } from "../utils/integration-crypto.js";
import { HttpError } from "../utils/http.js";

const { inboxes, inboxThreads } = schema;

export interface CreateInboxInput {
  emailAddress: string;
  displayName?: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  smtpSecure?: boolean;
  dailySendLimit?: number;
}

function toPublicInbox(row: typeof inboxes.$inferSelect) {
  const { smtpPasswordEncrypted: _omit, ...rest } = row;
  return { ...rest, smtpConfigured: !!row.smtpPasswordEncrypted };
}

export class InboxService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async listInboxes(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(inboxes)
      .where(eq(inboxes.workspaceId, workspaceId))
      .orderBy(desc(inboxes.createdAt));
    const data = rows.map(toPublicInbox);
    return { workspaceId, data, total: data.length };
  }

  async createInbox(workspaceId: string, input: CreateInboxInput) {
    const encryptionKey = this.config.INTEGRATION_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);
    }
    const [row] = await this.db
      .insert(inboxes)
      .values({
        workspaceId,
        emailAddress: input.emailAddress,
        displayName: input.displayName ?? null,
        provider: "smtp",
        dailySendLimit: input.dailySendLimit ?? 50,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpUsername: input.smtpUsername,
        smtpPasswordEncrypted: encryptSecret(input.smtpPassword, encryptionKey),
        smtpSecure: input.smtpSecure ?? true,
      })
      .returning();
    return toPublicInbox(row!);
  }

  async listThreads(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(inboxThreads)
      .where(eq(inboxThreads.workspaceId, workspaceId))
      .orderBy(desc(inboxThreads.updatedAt));
    return { workspaceId, data: rows, total: rows.length };
  }
}

export function buildInboxService(db: Db | null, config: Env): InboxService | null {
  if (!db) return null;
  return new InboxService(db, config);
}
