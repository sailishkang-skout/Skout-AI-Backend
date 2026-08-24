import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, recordEvidence } from "@skout/db";
import type { ContactCreateInput, ContactUpdateInput } from "@skout/shared";
import { HttpError } from "@skout/auth";
import type { CompaniesService } from "./companies.service.js";
import type { AuditService } from "./audit.service.js";
import { serviceLog } from "../lib/obs.js";
import {
  asFieldSourcesMap,
  filterAutoFillablePatch,
  markManualSources,
  mergeAutoFillSources,
  DEFAULT_AUTO_FILL_CONFIDENCE,
  type FieldSource,
  type FieldSourcesMap,
} from "../utils/field-sources.js";

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
  fieldSources: FieldSourcesMap;
  createdAt: string;
  updatedAt: string;
}

/** Fields eligible for auto-fill — deliberately excludes identity/ownership fields. */
export interface ContactAutoFillPatch {
  email?: string;
  phone?: string;
  title?: string;
  linkedinUrl?: string;
  lifecycleStage?: string;
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
    fieldSources: asFieldSourcesMap(row.fieldSources),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ContactsService {
  constructor(
    private readonly db: Db,
    private readonly companiesService: CompaniesService,
    private readonly auditService: AuditService
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

  async create(workspaceId: string, actorId: string | undefined, input: ContactCreateInput): Promise<ContactDto> {
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

    const dto = toDto(row);
    await this.auditService.record(workspaceId, actorId, "create", "contact", dto.id, null, dto);
    log.info("contact created", { workspaceId, contactId: row.id });
    return dto;
  }

  async update(
    workspaceId: string,
    id: string,
    actorId: string | undefined,
    input: ContactUpdateInput
  ): Promise<ContactDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    if (input.companyId && !(await this.companiesService.existsInWorkspace(workspaceId, input.companyId))) {
      throw new HttpError("company_not_found", 404);
    }

    // R13.3: a human editing a field via this endpoint marks it "manual" — auto-fill can
    // never overwrite it again after this. Only the auto-fillable subset is tracked; identity
    // fields (name, companyId, ownerId, sourceProspectId) aren't part of the provenance map.
    const editedAutoFillable = (["email", "phone", "title", "linkedinUrl", "lifecycleStage"] as const).filter(
      (field) => input[field] !== undefined
    );
    const nextFieldSources =
      editedAutoFillable.length > 0
        ? markManualSources(asFieldSourcesMap(existing.fieldSources), editedAutoFillable)
        : undefined;

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
        ...(nextFieldSources !== undefined ? { fieldSources: nextFieldSources } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
      .returning();

    const dto = row ? toDto(row) : null;
    if (dto) {
      await this.auditService.record(workspaceId, actorId, "update", "contact", id, existing, dto);
    }
    if (row) log.info("contact updated", { workspaceId, contactId: id });
    return dto;
  }

  /**
   * R13.3 — auto-fill fields from enrichment / meeting notes / call notes. Fields a human has
   * already manually edited are silently skipped (never overwritten); returns which fields
   * were actually applied vs. skipped so the caller (e.g. the enrichment pipeline) can log it.
   */
  async autoFill(
    workspaceId: string,
    id: string,
    patch: ContactAutoFillPatch,
    source: FieldSource,
    confidence?: number
  ): Promise<{ contact: ContactDto; applied: string[]; skipped: string[] } | null> {
    if (source === "manual") {
      throw new HttpError("invalid_auto_fill_source", 400, { reason: "use update() for manual edits" });
    }
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    const { applied, skipped } = filterAutoFillablePatch(patch, existing.fieldSources);
    const appliedFields = Object.keys(applied);
    if (appliedFields.length === 0) {
      return { contact: existing, applied: [], skipped };
    }

    const nextFieldSources = mergeAutoFillSources(existing.fieldSources, appliedFields, source, confidence);

    const [row] = await this.db
      .update(contacts)
      .set({ ...applied, fieldSources: nextFieldSources, updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
      .returning();

    const dto = toDto(row);
    await this.auditService.record(workspaceId, undefined, "update", "contact", id, existing, dto);
    log.info("contact auto-filled", { workspaceId, contactId: id, source, applied: appliedFields, skipped });

    // §5.3 / Task 14 — dual-write provenance into the canonical Evidence Ledger, same pattern
    // as CompaniesService.autoFill. Best-effort: must never fail the auto-fill itself.
    for (const field of appliedFields) {
      try {
        await recordEvidence(this.db, {
          workspaceId,
          entityType: "contact",
          entityId: id,
          attribute: field,
          value: (applied as Record<string, unknown>)[field as keyof typeof applied],
          source,
          observedAt: new Date(),
          confidence: confidence ?? DEFAULT_AUTO_FILL_CONFIDENCE[source],
          method: "crm_autofill",
        });
      } catch (err) {
        log.error("evidence ledger dual-write failed for contact auto-fill", { err, workspaceId, contactId: id, field });
      }
    }

    return { contact: dto, applied: appliedFields, skipped };
  }

  async softDelete(workspaceId: string, id: string, actorId: string | undefined): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    const [row] = await this.db
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
      .returning();

    const dto = row ? toDto(row) : null;
    if (dto) {
      await this.auditService.record(workspaceId, actorId, "delete", "contact", id, existing, dto);
    }
    log.info("contact soft-deleted", { workspaceId, contactId: id });
    return true;
  }
}

export function buildContactsService(
  db: Db | null,
  companiesService: CompaniesService | null,
  auditService: AuditService | null
): ContactsService | null {
  return db && companiesService && auditService ? new ContactsService(db, companiesService, auditService) : null;
}
