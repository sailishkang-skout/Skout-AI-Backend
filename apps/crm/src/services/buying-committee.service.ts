import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "@skout/auth";

const { buyingCommittees, buyingCommitteeMembers, deals, contacts, companies } = schema;

export interface CommitteeMemberInput {
  contactId: string;
  role?: string;
  influence?: number;
  notes?: string;
}

export interface CommitteeMemberDto {
  id: string;
  committeeId: string;
  contactId: string;
  role: string;
  influence: number;
  notes: string | null;
}

function toMemberDto(row: typeof buyingCommitteeMembers.$inferSelect): CommitteeMemberDto {
  return {
    id: row.id,
    committeeId: row.committeeId,
    contactId: row.contactId,
    role: row.role,
    influence: row.influence,
    notes: row.notes ?? null,
  };
}

type CrmDb = Pick<Db, "select" | "insert" | "update" | "delete" | "transaction">;

/**
 * §8.12 CRM Intelligence — BuyingCommittee. Exactly one of `dealId`/`companyId` scopes a
 * committee; get-or-create keeps callers from needing to check existence first.
 */
export class BuyingCommitteeService {
  constructor(private readonly db: CrmDb) {}

  private async getOrCreateForDeal(workspaceId: string, dealId: string): Promise<string> {
    const [deal] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId)))
      .limit(1);
    if (!deal) throw new HttpError("deal_not_found", 404);

    const [existing] = await this.db
      .select({ id: buyingCommittees.id })
      .from(buyingCommittees)
      .where(eq(buyingCommittees.dealId, dealId))
      .limit(1);
    if (existing) return existing.id;

    const [created] = await this.db
      .insert(buyingCommittees)
      .values({ workspaceId, dealId })
      .returning({ id: buyingCommittees.id });
    if (!created) throw new HttpError("Failed to create buying committee", 500);
    return created.id;
  }

  private async getOrCreateForCompany(workspaceId: string, companyId: string): Promise<string> {
    const [company] = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)))
      .limit(1);
    if (!company) throw new HttpError("company_not_found", 404);

    const [existing] = await this.db
      .select({ id: buyingCommittees.id })
      .from(buyingCommittees)
      .where(eq(buyingCommittees.companyId, companyId))
      .limit(1);
    if (existing) return existing.id;

    const [created] = await this.db
      .insert(buyingCommittees)
      .values({ workspaceId, companyId })
      .returning({ id: buyingCommittees.id });
    if (!created) throw new HttpError("Failed to create buying committee", 500);
    return created.id;
  }

  async listForDeal(workspaceId: string, dealId: string): Promise<CommitteeMemberDto[]> {
    const [committee] = await this.db
      .select({ id: buyingCommittees.id })
      .from(buyingCommittees)
      .where(and(eq(buyingCommittees.dealId, dealId), eq(buyingCommittees.workspaceId, workspaceId)))
      .limit(1);
    if (!committee) return [];

    const rows = await this.db
      .select()
      .from(buyingCommitteeMembers)
      .where(eq(buyingCommitteeMembers.committeeId, committee.id));
    return rows.map(toMemberDto);
  }

  async listForCompany(workspaceId: string, companyId: string): Promise<CommitteeMemberDto[]> {
    const [committee] = await this.db
      .select({ id: buyingCommittees.id })
      .from(buyingCommittees)
      .where(and(eq(buyingCommittees.companyId, companyId), eq(buyingCommittees.workspaceId, workspaceId)))
      .limit(1);
    if (!committee) return [];

    const rows = await this.db
      .select()
      .from(buyingCommitteeMembers)
      .where(eq(buyingCommitteeMembers.committeeId, committee.id));
    return rows.map(toMemberDto);
  }

  async addMemberToDeal(workspaceId: string, dealId: string, input: CommitteeMemberInput): Promise<CommitteeMemberDto> {
    const [contact] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!contact) throw new HttpError("contact_not_found", 404);

    const committeeId = await this.getOrCreateForDeal(workspaceId, dealId);

    const [row] = await this.db
      .insert(buyingCommitteeMembers)
      .values({
        committeeId,
        contactId: input.contactId,
        role: input.role ?? "unknown",
        influence: input.influence ?? 3,
        notes: input.notes,
      })
      .onConflictDoUpdate({
        target: [buyingCommitteeMembers.committeeId, buyingCommitteeMembers.contactId],
        set: {
          role: input.role ?? "unknown",
          influence: input.influence ?? 3,
          notes: input.notes,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new HttpError("Failed to add committee member", 500);
    return toMemberDto(row);
  }

  async addMemberToCompany(
    workspaceId: string,
    companyId: string,
    input: CommitteeMemberInput
  ): Promise<CommitteeMemberDto> {
    const [contact] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!contact) throw new HttpError("contact_not_found", 404);

    const committeeId = await this.getOrCreateForCompany(workspaceId, companyId);

    const [row] = await this.db
      .insert(buyingCommitteeMembers)
      .values({
        committeeId,
        contactId: input.contactId,
        role: input.role ?? "unknown",
        influence: input.influence ?? 3,
        notes: input.notes,
      })
      .onConflictDoUpdate({
        target: [buyingCommitteeMembers.committeeId, buyingCommitteeMembers.contactId],
        set: {
          role: input.role ?? "unknown",
          influence: input.influence ?? 3,
          notes: input.notes,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new HttpError("Failed to add committee member", 500);
    return toMemberDto(row);
  }

  async removeMember(workspaceId: string, memberId: string): Promise<void> {
    // Scope the delete through a join on workspaceId so a member row can't be removed
    // by guessing an ID belonging to another workspace's committee.
    const [row] = await this.db
      .select({ id: buyingCommitteeMembers.id })
      .from(buyingCommitteeMembers)
      .innerJoin(buyingCommittees, eq(buyingCommittees.id, buyingCommitteeMembers.committeeId))
      .where(and(eq(buyingCommitteeMembers.id, memberId), eq(buyingCommittees.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new HttpError("committee_member_not_found", 404);

    await this.db.delete(buyingCommitteeMembers).where(eq(buyingCommitteeMembers.id, memberId));
  }
}

export function buildBuyingCommitteeService(db: CrmDb | null): BuyingCommitteeService | null {
  return db ? new BuyingCommitteeService(db) : null;
}

