import { eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import { recordEvidence } from "./evidence.service.js";

const log = createLogger("prospect-crm-link");
const { contacts, companies, prospectActivations } = schema;

export interface ProspectCrmLinkResult {
  contactId: string | null;
  companyId: string | null;
  created: boolean;
}

/**
 * §5.2 — resolve or create a native CRM contact linked via `contacts.sourceProspectId`.
 * Used on sequence enroll / activation so prospect↔CRM identity is not left open.
 * Best-effort: never throws to callers that wrap it.
 */
export async function ensureContactLinkedToProspect(
  db: Db,
  workspaceId: string,
  prospectId: string,
  opts?: { email?: string | null; fullName?: string | null; companyDomain?: string | null; companyName?: string | null }
): Promise<ProspectCrmLinkResult> {
  const [existing] = await db
    .select({ id: contacts.id, companyId: contacts.companyId })
    .from(contacts)
    .where(scopedTo(contacts, workspaceId, eq(contacts.sourceProspectId, prospectId), isNull(contacts.deletedAt)))
    .limit(1);
  if (existing) {
    return { contactId: existing.id, companyId: existing.companyId, created: false };
  }

  let email = opts?.email?.trim().toLowerCase() ?? null;
  let fullName = opts?.fullName ?? null;
  let companyDomain = opts?.companyDomain ?? null;
  let companyName = opts?.companyName ?? null;

  if (!email || !fullName) {
    const [activation] = await db
      .select({ snapshot: prospectActivations.snapshot })
      .from(prospectActivations)
      .where(scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, prospectId)))
      .limit(1);
    const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;
    email = email ?? (typeof snap.email === "string" ? snap.email.toLowerCase() : null);
    fullName =
      fullName ??
      (typeof snap.fullName === "string"
        ? snap.fullName
        : typeof snap.firstName === "string"
          ? [snap.firstName, snap.lastName].filter(Boolean).join(" ")
          : null);
    companyDomain =
      companyDomain ?? (typeof snap.companyDomain === "string" ? snap.companyDomain : null);
    companyName = companyName ?? (typeof snap.companyName === "string" ? snap.companyName : null);
  }

  let companyId: string | null = null;
  if (companyDomain || companyName) {
    if (companyDomain) {
      const [byDomain] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(scopedTo(companies, workspaceId, eq(companies.domain, companyDomain), isNull(companies.deletedAt)))
        .limit(1);
      companyId = byDomain?.id ?? null;
    }
    if (!companyId && companyName) {
      const [createdCo] = await db
        .insert(companies)
        .values({
          workspaceId,
          name: companyName,
          domain: companyDomain ?? undefined,
          sourceProspectCompanyId: null,
          fieldSources: {},
        })
        .returning({ id: companies.id });
      companyId = createdCo?.id ?? null;
    }
  }

  const parts = (fullName ?? email?.split("@")[0] ?? "Prospect").trim().split(/\s+/);
  const firstName = parts[0] ?? "Prospect";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;

  const [row] = await db
    .insert(contacts)
    .values({
      workspaceId,
      firstName,
      lastName,
      email: email ?? undefined,
      companyId,
      sourceProspectId: prospectId,
      fieldSources: {},
    })
    .returning({ id: contacts.id });

  if (!row) return { contactId: null, companyId, created: false };

  try {
    await recordEvidence(db, {
      workspaceId,
      entityType: "contact",
      entityId: row.id,
      attribute: "sourceProspectId",
      value: prospectId,
      source: "identity_link",
      observedAt: new Date(),
      confidence: 1,
      method: "ensure_contact_linked_to_prospect",
    });
  } catch (err) {
    log.warn("evidence write failed for prospect↔CRM link", { err });
  }

  log.info("created CRM contact linked to prospect", { workspaceId, prospectId, contactId: row.id });
  try {
    const { incrJourneyMetric } = await import("./journey-metrics.js");
    incrJourneyMetric("prospectCrmLink");
  } catch {
    /* ignore */
  }
  return { contactId: row.id, companyId, created: true };
}
