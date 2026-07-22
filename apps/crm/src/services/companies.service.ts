import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { CompanyCreateInput, CompanyUpdateInput } from "@skout/shared";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("companies");
const { companies } = schema;

export interface CompanyDto {
  id: string;
  workspaceId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  revenue: number | null;
  location: string | null;
  ownerId: string | null;
  status: string;
  sourceProspectCompanyId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof companies.$inferSelect): CompanyDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    employeeCount: row.employeeCount,
    revenue: row.revenue === null ? null : Number(row.revenue),
    location: row.location,
    ownerId: row.ownerId,
    status: row.status,
    sourceProspectCompanyId: row.sourceProspectCompanyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class CompaniesService {
  constructor(private readonly db: Db) {}

  async list(
    workspaceId: string,
    options: { limit: number; offset: number; ownerId?: string }
  ): Promise<{ data: CompanyDto[]; total: number }> {
    const conditions = [eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)];
    if (options.ownerId) conditions.push(eq(companies.ownerId, options.ownerId));

    const rows = await this.db
      .select()
      .from(companies)
      .where(and(...conditions))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  async getById(workspaceId: string, id: string): Promise<CompanyDto | null> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  async create(workspaceId: string, input: CompanyCreateInput): Promise<CompanyDto> {
    const [row] = await this.db
      .insert(companies)
      .values({
        workspaceId,
        name: input.name,
        domain: input.domain,
        industry: input.industry,
        employeeCount: input.employeeCount,
        revenue: input.revenue?.toString(),
        location: input.location,
        ownerId: input.ownerId,
        status: input.status,
        sourceProspectCompanyId: input.sourceProspectCompanyId,
      })
      .returning();
    log.info("company created", { workspaceId, companyId: row.id });
    return toDto(row);
  }

  async update(workspaceId: string, id: string, input: CompanyUpdateInput): Promise<CompanyDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    const [row] = await this.db
      .update(companies)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
        ...(input.industry !== undefined ? { industry: input.industry } : {}),
        ...(input.employeeCount !== undefined ? { employeeCount: input.employeeCount } : {}),
        ...(input.revenue !== undefined ? { revenue: input.revenue.toString() } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.sourceProspectCompanyId !== undefined
          ? { sourceProspectCompanyId: input.sourceProspectCompanyId }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId)))
      .returning();
    if (row) log.info("company updated", { workspaceId, companyId: id });
    return row ? toDto(row) : null;
  }

  async softDelete(workspaceId: string, id: string): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    await this.db
      .update(companies)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId)));
    log.info("company soft-deleted", { workspaceId, companyId: id });
    return true;
  }

  /** Confirms a company id belongs to the given workspace (used by contacts/deals create). */
  async existsInWorkspace(workspaceId: string, id: string): Promise<boolean> {
    return (await this.getById(workspaceId, id)) !== null;
  }
}

export function buildCompaniesService(db: Db | null): CompaniesService | null {
  return db ? new CompaniesService(db) : null;
}
