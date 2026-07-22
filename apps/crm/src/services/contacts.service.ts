import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ContactCreateInput, ContactUpdateInput } from "@skout/shared";
import { HttpError } from "@skout/auth";
import type { CompaniesService } from "./companies.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("contacts");
const { contacts } = schema;

export interface ContactDto {
  id: string;
  workspaceId: string;
  companyId: string | null;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  linkedinUrl: string | null;
  ownerId: string | null;
  lifecycleStage: string;
  sourceProspectId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof contacts.$inferSelect): ContactDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    companyId: row.companyId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    title: row.title,
    linkedinUrl: row.linkedinUrl,
    ownerId: row.ownerId,
    lifecycleStage: row.lifecycleStage,
    sourceProspectId: row.sourceProspectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ContactsService {
  constructor(
    private readonly db: Db,
    private readonly companiesService: CompaniesService
  ) {}

  async list(
    workspaceId: string,
    options: { limit: number; offset: number; companyId?: string }
  ): Promise<{ data: ContactDto[]; total: number }> {
    const conditions = [eq(contacts.workspaceId, workspaceId), isNull(contacts.deletedAt)];
    if (options.companyId) conditions.push(eq(contacts.companyId, options.companyId));

    const rows = await this.db
      .select()
      .from(contacts)
      .where(and(...conditions))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  async getById(workspaceId: string, id: string): Promise<ContactDto | null> {
    const [row] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId), isNull(contacts.deletedAt)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  async create(workspaceId: string, input: ContactCreateInput): Promise<ContactDto> {
    if (input.companyId && !(await this.companiesService.existsInWorkspace(workspaceId, input.companyId))) {
      throw new HttpError("company_not_found", 404);
    }

    const [row] = await this.db
      .insert(contacts)
      .values({
        workspaceId,
        companyId: input.companyId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        title: input.title,
        linkedinUrl: input.linkedinUrl,
        ownerId: input.ownerId,
        lifecycleStage: input.lifecycleStage,
        sourceProspectId: input.sourceProspectId,
      })
      .returning();
    log.info("contact created", { workspaceId, contactId: row.id });
    return toDto(row);
  }

  async update(workspaceId: string, id: string, input: ContactUpdateInput): Promise<ContactDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    if (input.companyId && !(await this.companiesService.existsInWorkspace(workspaceId, input.companyId))) {
      throw new HttpError("company_not_found", 404);
    }

    const [row] = await this.db
      .update(contacts)
      .set({
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.linkedinUrl !== undefined ? { linkedinUrl: input.linkedinUrl } : {}),
        ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.lifecycleStage !== undefined ? { lifecycleStage: input.lifecycleStage } : {}),
        ...(input.sourceProspectId !== undefined ? { sourceProspectId: input.sourceProspectId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
      .returning();
    if (row) log.info("contact updated", { workspaceId, contactId: id });
    return row ? toDto(row) : null;
  }

  async softDelete(workspaceId: string, id: string): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    await this.db
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)));
    log.info("contact soft-deleted", { workspaceId, contactId: id });
    return true;
  }
}

export function buildContactsService(db: Db | null, companiesService: CompaniesService | null): ContactsService | null {
  return db && companiesService ? new ContactsService(db, companiesService) : null;
}
