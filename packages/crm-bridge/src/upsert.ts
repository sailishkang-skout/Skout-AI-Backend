import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";

const { contacts, companies } = schema;

export interface ProspectSnapshotPreview {
  fullName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  title?: string;
  linkedinUrl?: string;
  companyDomain?: string;
  industry?: string;
  employeeCount?: number;
  location?: string;
}

export function splitName(fullName: string | undefined): { firstName: string; lastName: string | null } {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) return { firstName: "Unknown", lastName: null };
  const [firstName, ...rest] = trimmed.split(/\s+/);
  return { firstName, lastName: rest.length > 0 ? rest.join(" ") : null };
}

/**
 * Matches an existing Company by `sourceProspectCompanyId`, or creates one from the prospect
 * snapshot. Shared by promoteProspectToDeal() and importListToCrm() — same correlation-key
 * upsert logic, different callers.
 */
export async function upsertCompanyBySourceProspect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  workspaceId: string,
  prospectCompanyId: string,
  snapshot: ProspectSnapshotPreview
): Promise<{ companyId: string; created: boolean; row?: typeof companies.$inferSelect }> {
  const [existing] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.sourceProspectCompanyId, prospectCompanyId)))
    .limit(1);
  if (existing) return { companyId: existing.id, created: false };

  const [company] = await tx
    .insert(companies)
    .values({
      workspaceId,
      name: snapshot.companyName ?? snapshot.companyDomain ?? "Unknown Company",
      domain: snapshot.companyDomain ?? null,
      industry: snapshot.industry ?? null,
      employeeCount: snapshot.employeeCount ?? null,
      location: snapshot.location ?? null,
      sourceProspectCompanyId: prospectCompanyId,
    })
    .returning();
  return { companyId: company.id, created: true, row: company };
}

/**
 * Matches an existing Contact by `sourceProspectId`, or creates one from the prospect snapshot.
 * Shared by promoteProspectToDeal() and importListToCrm().
 */
export async function upsertContactBySourceProspect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  workspaceId: string,
  prospectId: string,
  companyId: string,
  snapshot: ProspectSnapshotPreview
): Promise<{ contactId: string; created: boolean; row?: typeof contacts.$inferSelect }> {
  const [existing] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.sourceProspectId, prospectId)))
    .limit(1);
  if (existing) return { contactId: existing.id, created: false };

  const { firstName, lastName } = splitName(snapshot.fullName);
  const [contact] = await tx
    .insert(contacts)
    .values({
      workspaceId,
      companyId,
      firstName,
      lastName,
      email: snapshot.email ?? null,
      phone: snapshot.phone ?? null,
      title: snapshot.title ?? null,
      linkedinUrl: snapshot.linkedinUrl ?? null,
      sourceProspectId: prospectId,
    })
    .returning();
  return { contactId: contact.id, created: true, row: contact };
}
