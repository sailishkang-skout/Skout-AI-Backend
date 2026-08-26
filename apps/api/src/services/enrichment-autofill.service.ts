import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, getLatestEvidenceByAttribute } from "@skout/db";
import { filterAutoFillablePatch, mergeAutoFillSources, asFieldSourcesMap, DEFAULT_AUTO_FILL_CONFIDENCE } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { recordEvidence } from "./evidence.service.js";
import { buildCrmInternalClient } from "./crm-internal.client.js";
import type { Env } from "../config/env.js";
import type { ProspectSnapshot } from "./enrichment/service.js";

const { contacts, companies } = schema;
const log = createLogger("enrichment-autofill");

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md for the full audit and rationale; one of the 9
 * confirmed instances listed there (formalized in Task 17 - this file previously only had the
 * informal note below, not the full block the other 8 files now carry).
 *   - Tables touched directly: contacts, companies (both owned by apps/crm) - read AND write
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: called from EnrichmentService.activate's hot path (see below) - an HTTP round
 *     trip into apps/crm here would add latency to prospect activation and a new failure mode
 *     this best-effort write is specifically designed to avoid
 *   - Review date: 2026-08-26 — Wave 2 proof: contact READ may use CRM internal HTTP when
 *     CRM_INTERNAL_BASE_URL + INTERNAL_SERVICE_TOKEN are set; writes remain direct SQL
 *     (transactional autofill + evidence dual-write).
 */

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
  snapshot: ProspectSnapshot & { prospectId: string; companyId: string },
  config?: Env
): Promise<void> {
  const contactPatch: Record<string, unknown> = {};
  if (snapshot.title) contactPatch.title = snapshot.title;
  if (snapshot.email) contactPatch.email = snapshot.email;
  if (snapshot.phone) contactPatch.phone = snapshot.phone;

  if (Object.keys(contactPatch).length > 0) {
    let contact: typeof contacts.$inferSelect | null = null;
    const internal = config ? buildCrmInternalClient(config) : null;
    if (internal) {
      try {
        const remote = await internal.getContactByProspectId(workspaceId, snapshot.prospectId);
        if (remote?.id) {
          // Re-load full row for update (internal GET returns row; cast for fieldSources)
          const [row] = await db
            .select()
            .from(contacts)
            .where(and(eq(contacts.id, String(remote.id)), eq(contacts.workspaceId, workspaceId)))
            .limit(1);
          contact = row ?? null;
          log.info("enrichment autofill contact resolved via CRM internal API", {
            workspaceId,
            contactId: remote.id,
          });
        }
      } catch (err) {
      log.warn("CRM internal contact lookup failed — falling back to SQL", { err });
      }
    }
    if (!contact) {
      const [row] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.sourceProspectId, snapshot.prospectId)))
        .limit(1);
      contact = row ?? null;
    }
    if (contact) {
      const existingSources = asFieldSourcesMap(contact.fieldSources);
      const evidenceByAttribute = await getLatestEvidenceByAttribute(db, workspaceId, "contact", contact.id);
      const { applied, skipped: _skipped } = filterAutoFillablePatch(contactPatch, existingSources, evidenceByAttribute);
      const appliedFields = Object.keys(applied);
      if (appliedFields.length > 0) {
        const nextFieldSources = mergeAutoFillSources(existingSources, appliedFields, "enrichment", undefined);
        await db
          .update(contacts)
          .set({ ...applied, fieldSources: nextFieldSources, updatedAt: new Date() })
          .where(eq(contacts.id, contact.id));
        log.info("enrichment auto-fill applied to contact", { workspaceId, contactId: contact.id, appliedFields });

        // §5.3 / Task 14 — dual-write provenance into the canonical Evidence Ledger. One row
        // per applied field, mirroring the per-field granularity `fieldSources` already tracks.
        // Best-effort: must never fail the auto-fill itself.
        for (const field of appliedFields) {
          try {
            await recordEvidence(db, {
              workspaceId,
              entityType: "contact",
              entityId: contact.id,
              attribute: field,
              value: (applied as Record<string, unknown>)[field],
              source: "enrichment",
              observedAt: new Date(),
              confidence: DEFAULT_AUTO_FILL_CONFIDENCE.enrichment,
              method: "enrichment_autofill",
            });
          } catch (err) {
            log.error("evidence ledger dual-write failed for contact auto-fill", { err, workspaceId, contactId: contact.id, field });
          }
        }
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
      const evidenceByAttribute = await getLatestEvidenceByAttribute(db, workspaceId, "company", company.id);
      const { applied, skipped: _skipped } = filterAutoFillablePatch(companyPatch, existingSources, evidenceByAttribute);
      const appliedFields = Object.keys(applied);
      if (appliedFields.length > 0) {
        const nextFieldSources = mergeAutoFillSources(existingSources, appliedFields, "enrichment", undefined);
        await db
          .update(companies)
          .set({ ...applied, fieldSources: nextFieldSources, updatedAt: new Date() })
          .where(eq(companies.id, company.id));
        log.info("enrichment auto-fill applied to company", { workspaceId, companyId: company.id, appliedFields });

        // §5.3 / Task 14 — same dual-write as the contact branch above.
        for (const field of appliedFields) {
          try {
            await recordEvidence(db, {
              workspaceId,
              entityType: "company",
              entityId: company.id,
              attribute: field,
              value: (applied as Record<string, unknown>)[field],
              source: "enrichment",
              observedAt: new Date(),
              confidence: DEFAULT_AUTO_FILL_CONFIDENCE.enrichment,
              method: "enrichment_autofill",
            });
          } catch (err) {
            log.error("evidence ledger dual-write failed for company auto-fill", { err, workspaceId, companyId: company.id, field });
          }
        }
      }
    }
  }
}
