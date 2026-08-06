import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { eq, desc, sql } from "drizzle-orm";

const log = createLogger("workspace.service");

export function createWorkspaceService(db: Db) {
  return {
    async getWorkspaceById(workspaceId: string) {
      const [workspace] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      return workspace ?? null;
    },

    async getWorkspaceWithCredits(workspaceId: string) {
      const [row] = await db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
          createdAt: schema.workspaces.createdAt,
          balance: schema.creditBalances.balance,
          slackWebhookUrl: schema.workspaces.slackWebhookUrl,
          meetingBotAutoJoinDefault: schema.workspaces.meetingBotAutoJoinDefault,
        })
        .from(schema.workspaces)
        .leftJoin(schema.creditBalances, eq(schema.creditBalances.workspaceId, schema.workspaces.id))
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      return row ?? null;
    },

    /** R17.4 — per-workspace Slack incoming-webhook URL for notification delivery. Pass null to disconnect. */
    async setSlackWebhook(workspaceId: string, slackWebhookUrl: string | null) {
      const [row] = await db
        .update(schema.workspaces)
        .set({ slackWebhookUrl, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, workspaceId))
        .returning({ id: schema.workspaces.id, slackWebhookUrl: schema.workspaces.slackWebhookUrl });
      return row ?? null;
    },

    /** R16.2 — workspace-wide default for new meetings' auto-join-bot flag. */
    async setMeetingBotAutoJoinDefault(workspaceId: string, enabled: boolean) {
      const [row] = await db
        .update(schema.workspaces)
        .set({ meetingBotAutoJoinDefault: enabled, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, workspaceId))
        .returning({ id: schema.workspaces.id, meetingBotAutoJoinDefault: schema.workspaces.meetingBotAutoJoinDefault });
      return row ?? null;
    },

    async renameWorkspace(workspaceId: string, name: string) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const [row] = await db
        .update(schema.workspaces)
        .set({ name, slug: `${slug}-${Math.random().toString(36).slice(2, 7)}`, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, workspaceId))
        .returning({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
        });
      if (!row) return null;
      log.info("workspace renamed", { workspaceId, name: row.name });
      return this.getWorkspaceWithCredits(workspaceId);
    },

    async getIcp(workspaceId: string) {
      const [row] = await db
        .select()
        .from(schema.workspaceIcp)
        .where(eq(schema.workspaceIcp.workspaceId, workspaceId))
        .limit(1);
      return row ?? null;
    },

    async upsertIcp(workspaceId: string, config: Record<string, unknown>) {
      const [row] = await db
        .insert(schema.workspaceIcp)
        .values({ workspaceId, config, version: 1, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.workspaceIcp.workspaceId,
          set: {
            config,
            version: sql`${schema.workspaceIcp.version} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning();
      log.info("workspace ICP upserted", { workspaceId, version: row?.version });
      return row;
    },

    async getCreditBalance(workspaceId: string) {
      const [row] = await db
        .select({ balance: schema.creditBalances.balance, updatedAt: schema.creditBalances.updatedAt })
        .from(schema.creditBalances)
        .where(eq(schema.creditBalances.workspaceId, workspaceId))
        .limit(1);
      return row ?? { balance: 0, updatedAt: null };
    },

    async getCreditTransactions(workspaceId: string, limit = 50, offset = 0) {
      const [countRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.creditTransactions)
        .where(eq(schema.creditTransactions.workspaceId, workspaceId));

      const rows = await db
        .select()
        .from(schema.creditTransactions)
        .where(eq(schema.creditTransactions.workspaceId, workspaceId))
        .orderBy(desc(schema.creditTransactions.createdAt))
        .limit(limit)
        .offset(offset);
      return {
        data: rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          amount: r.amount,
          action: r.action,
          referenceId: r.referenceId,
          createdAt: r.createdAt.toISOString(),
        })),
        total: countRow?.total ?? 0,
        limit,
        offset,
      };
    },

    async addCredits(workspaceId: string, amount: number, action = "admin_topup", referenceId?: string) {
      const current = await this.getCreditBalance(workspaceId);
      const next = current.balance + amount;

      await db
        .insert(schema.creditBalances)
        .values({ workspaceId, balance: next })
        .onConflictDoUpdate({
          target: schema.creditBalances.workspaceId,
          set: { balance: next, updatedAt: new Date() },
        });

      await db.insert(schema.creditTransactions).values({
        workspaceId,
        amount,
        action,
        referenceId: referenceId ?? null,
      });

      log.info("credits adjusted", {
        workspaceId,
        amount,
        action,
        referenceId,
        balance: next,
      });

      return next;
    },
  };
}
