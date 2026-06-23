import { and, count, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { getProspectById, type OpenSearchConfig, type ProspectDocument } from "@skout/opensearch";
import type { ProspectList, ProspectListMember } from "./enrichment/types.js";
import { snapshotFromCorpusDoc } from "../utils/verified-email.js";

const { lists, listMembers, prospectActivations } = schema;

export interface AddMemberInput {
  prospectId: string;
  snapshot?: Record<string, unknown>;
}

const DISPLAY_FIELDS = [
  "fullName",
  "title",
  "email",
  "companyName",
  "companyDomain",
  "linkedinUrl",
] as const;

function snapshotHasDisplayFields(snapshot: Record<string, unknown>): boolean {
  return DISPLAY_FIELDS.some((key) => {
    const value = snapshot[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function mergeSnapshots(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) merged[key] = trimmed;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function osDocToSnapshot(doc: ProspectDocument): Record<string, unknown> {
  return snapshotFromCorpusDoc(doc) as unknown as Record<string, unknown>;
}

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
    members: AddMemberInput[]
  ): Promise<ProspectList | null> {
    const list = await this.getListById(workspaceId, listId);
    if (!list) return null;
    if (members.length === 0) return list;

    for (const member of members) {
      const { prospectId, snapshot: providedSnapshot } = member;
      let snapshot: Record<string, unknown> = { prospectId };
      let companyId = prospectId;
      let osFound = false;

      if (this.osCfg) {
        const doc = await getProspectById(this.osCfg, prospectId).catch(() => null);
        if (doc) {
          osFound = true;
          snapshot = osDocToSnapshot(doc);
          companyId = doc.companyId;
        }
      }

      if (providedSnapshot) {
        snapshot = mergeSnapshots(snapshot, providedSnapshot);
        companyId = String(providedSnapshot.companyId ?? companyId);
      }

      const [existing] = await this.db
        .select()
        .from(prospectActivations)
        .where(
          and(
            eq(prospectActivations.workspaceId, workspaceId),
            eq(prospectActivations.prospectId, prospectId)
          )
        )
        .limit(1);

      const existingSnapshot =
        existing?.snapshot && typeof existing.snapshot === "object"
          ? (existing.snapshot as Record<string, unknown>)
          : null;

      if (existingSnapshot) {
        snapshot = mergeSnapshots(existingSnapshot, snapshot);
        companyId = existing?.companyId ?? companyId;
      }

      const hasProvided = Boolean(providedSnapshot && snapshotHasDisplayFields(providedSnapshot));
      const shouldUpsert = existingSnapshot
        ? osFound || hasProvided
        : snapshotHasDisplayFields(snapshot);

      if (shouldUpsert) {
        const patch = JSON.stringify(snapshot);
        await this.db
          .insert(prospectActivations)
          .values({ workspaceId, prospectId, companyId, snapshot })
          .onConflictDoUpdate({
            target: [prospectActivations.workspaceId, prospectActivations.prospectId],
            set: {
              snapshot: sql`coalesce(${prospectActivations.snapshot}, '{}'::jsonb) || ${patch}::jsonb`,
              companyId,
              updatedAt: new Date(),
            },
          });
      }
    }

    await this.db
      .insert(listMembers)
      .values(members.map((member) => ({ listId, prospectId: member.prospectId })))
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
