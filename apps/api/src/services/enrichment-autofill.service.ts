import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { filterAutoFillablePatch, mergeAutoFillSources, asFieldSourcesMap } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { ProspectSnapshot } from "./enrichment/service.js";

const { contacts, companies } = schema;
const log = createLogger("enrichment-autofill");

/**
 * R13.3 — when enrichment refreshes a prospect's snapshot, mirror any new title/email/phone into
 * a linked CRM contact (matched via `contacts.sourceProspectId`), and industry/employeeCount/
 * location into a linked company (matched via `companies.sourceProspectCompanyId`), tagged
 * `source: "enrichment"`. Uses the same filterAutoFillablePatch/mergeAutoFillSources pair
 * apps/crm's ContactsService.autoFill uses, so "manual wins forever" holds here too.
 *
 * apps/api and apps/crm are separately deployed services sharing one Postgres (see
 * cro-summary.service.ts's header comment for the established precedent) — this writes directly
 * rather than calling apps/crm over HTTP.
 *
 * Best-effort by design: called from `EnrichmentService.activate`'s hot path, so a lookup/merge
 * failure here must never fail the activation itself — callers should wrap this in try/catch.
 */
export async function applyEnrichmentAutoFill(
  db: Db,
  workspaceId: string,
  snapshot: ProspectSnapshot & { prospectId: string; companyId: string }
): Promise<void> {
  const contactPatch: Record<string, unknown> = {};
  if (snapshot.title) contactPatch.title = snapshot.title;
  if (snapshot.email) contactPatch.email = snapshot.email;
  if (snapshot.phone) contactPatch.phone = snapshot.phone;

  if (Object.keys(contactPatch).length > 0) {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.sourceProspectId, snapshot.prospectId)))
      .limit(1);
    if (contact) {
      const existingSources = asFieldSourcesMap(contact.fieldSources);
      const { applied, skipped: _skipped } = filterAutoFillablePatch(contactPatch, existingSources);
      const appliedFields = Object.keys(applied);
      if (appliedFields.length > 0) {
        const nextFieldSources = mergeAutoFillSources(existingSources, appliedFields, "enrichment", undefined);
        await db
          .update(contacts)
          .set({ ...applied, fieldSources: nextFieldSources, updatedAt: new Date() })
          .where(eq(contacts.id, contact.id));
        log.info("enrichment auto-fill applied to contact", { workspaceId, contactId: contact.id, appliedFields });
      }
    }
  }

  const companyPatch: Record<string, unknown> = {};
  if (snapshot.industry) companyPatch.industry = snapshot.industry;
  if (snapshot.employeeCount != null) companyPatch.employeeCount = snapshot.employeeCount;
  if (snapshot.country) companyPatch.location = snapshot.country;

  if (Object.keys(companyPatch).length > 0) {
    const [company] = await db
      .select()
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.sourceProspectCompanyId, snapshot.companyId)))
      .limit(1);
    if (company) {
      const existingSources = asFieldSourcesMap(company.fieldSources);
      const { applied, skipped: _skipped } = filterAutoFillablePatch(companyPatch, existingSources);
      const appliedFields = Object.keys(applied);
      if (appliedFields.length > 0) {
        const nextFieldSources = mergeAutoFillSources(existingSources, appliedFields, "enrichment", undefined);
        await db
          .update(companies)
          .set({ ...applied, fieldSources: nextFieldSources, updatedAt: new Date() })
          .where(eq(companies.id, company.id));
        log.info("enrichment auto-fill applied to company", { workspaceId, companyId: company.id, appliedFields });
      }
    }
  }
}
