import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { eq, desc, sql } from "drizzle-orm";

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
        })
        .from(schema.workspaces)
        .leftJoin(schema.creditBalances, eq(schema.creditBalances.workspaceId, schema.workspaces.id))
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
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

      return next;
    },
  };
}
