import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { getProspectById, type OpenSearchConfig } from "@skout/opensearch";
import type { ProspectList, ProspectListMember } from "./enrichment/types.js";

const { lists, listMembers, prospectActivations } = schema;

export class ListService {
  constructor(
    private readonly db: Db,
    private readonly osCfg: OpenSearchConfig | null
  ) {}

  async createList(workspaceId: string, name: string): Promise<ProspectList> {
    const [row] = await this.db
      .insert(lists)
      .values({ workspaceId, name })
      .returning();
    return {
      id: row.id,
      workspaceId,
      name: row.name,
      prospectCount: 0,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getLists(workspaceId: string): Promise<ProspectList[]> {
    const rows = await this.db
      .select({
        id: lists.id,
        workspaceId: lists.workspaceId,
        name: lists.name,
        createdAt: lists.createdAt,
        memberCount: count(listMembers.prospectId),
      })
      .from(lists)
      .leftJoin(listMembers, eq(listMembers.listId, lists.id))
      .where(eq(lists.workspaceId, workspaceId))
      .groupBy(lists.id, lists.workspaceId, lists.name, lists.createdAt)
      .orderBy(desc(lists.createdAt));

    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      prospectCount: Number(r.memberCount),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async getListById(workspaceId: string, listId: string): Promise<ProspectList | null> {
    const rows = await this.db
      .select({
        id: lists.id,
        workspaceId: lists.workspaceId,
        name: lists.name,
        createdAt: lists.createdAt,
        memberCount: count(listMembers.prospectId),
      })
      .from(lists)
      .leftJoin(listMembers, eq(listMembers.listId, lists.id))
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)))
      .groupBy(lists.id, lists.workspaceId, lists.name, lists.createdAt);

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      prospectCount: Number(row.memberCount),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async addMembers(
    workspaceId: string,
    listId: string,
    prospectIds: string[]
  ): Promise<ProspectList | null> {
    const list = await this.getListById(workspaceId, listId);
    if (!list) return null;
    if (prospectIds.length === 0) return list;

    // Fetch OS doc per prospectId and upsert into prospect_activations
    for (const prospectId of prospectIds) {
      let snapshot: Record<string, unknown> = { prospectId };
      let companyId = prospectId;

      if (this.osCfg) {
        const doc = await getProspectById(this.osCfg, prospectId).catch(() => null);
        if (doc) {
          snapshot = {
            prospectId: doc.prospectId,
            companyId: doc.companyId,
            fullName: doc.fullName,
            title: doc.title,
            seniority: doc.seniority,
            email: doc.email,
            companyDomain: doc.companyDomain,
            companyName: doc.companyName,
            industry: doc.industry,
            country: doc.country,
            employeeCount: doc.employeeCount,
          };
          companyId = doc.companyId;
        }
      }

      await this.db
        .insert(prospectActivations)
        .values({ workspaceId, prospectId, companyId, snapshot })
        .onConflictDoUpdate({
          target: [prospectActivations.workspaceId, prospectActivations.prospectId],
          set: { snapshot, updatedAt: new Date() },
        });
    }

    await this.db
      .insert(listMembers)
      .values(prospectIds.map((prospectId) => ({ listId, prospectId })))
      .onConflictDoNothing();

    return this.getListByIdWithMembers(workspaceId, listId);
  }

  async getMembers(workspaceId: string, listId: string): Promise<ProspectListMember[] | null> {
    const list = await this.getListById(workspaceId, listId);
    if (!list) return null;

    const memberRows = await this.db
      .select({
        prospectId: listMembers.prospectId,
        addedAt: listMembers.addedAt,
        companyId: prospectActivations.companyId,
        snapshot: prospectActivations.snapshot,
      })
      .from(listMembers)
      .leftJoin(
        prospectActivations,
        and(
          eq(prospectActivations.prospectId, listMembers.prospectId),
          eq(prospectActivations.workspaceId, workspaceId)
        )
      )
      .where(eq(listMembers.listId, listId));

    return memberRows.map((r) => ({
      prospectId: r.prospectId,
      companyId: r.companyId ?? r.prospectId,
      snapshot: (r.snapshot as Record<string, unknown>) ?? {},
      addedAt: r.addedAt.toISOString(),
    }));
  }

  private async getListByIdWithMembers(workspaceId: string, listId: string): Promise<ProspectList | null> {
    const base = await this.getListById(workspaceId, listId);
    if (!base) return null;

    const memberRows = await this.db
      .select({
        prospectId: listMembers.prospectId,
        addedAt: listMembers.addedAt,
        companyId: prospectActivations.companyId,
        snapshot: prospectActivations.snapshot,
      })
      .from(listMembers)
      .leftJoin(
        prospectActivations,
        and(
          eq(prospectActivations.prospectId, listMembers.prospectId),
          eq(prospectActivations.workspaceId, workspaceId)
        )
      )
      .where(eq(listMembers.listId, listId));

    const members: ProspectListMember[] = memberRows.map((r) => ({
      prospectId: r.prospectId,
      companyId: r.companyId ?? r.prospectId,
      snapshot: (r.snapshot as Record<string, unknown>) ?? {},
      addedAt: r.addedAt.toISOString(),
    }));

    return { ...base, members };
  }
}

export function buildListService(db: Db | null, osCfg: OpenSearchConfig | null): ListService | null {
  if (!db) return null;
  return new ListService(db, osCfg);
}
