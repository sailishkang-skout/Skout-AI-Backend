import { eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { HttpError } from "@skout/auth";

const { companies, contacts, deals, activities, tasks, meetings, calls } = schema;

type CompanyRow = typeof companies.$inferSelect;
type ContactRow = typeof contacts.$inferSelect;

export interface IdentityMergeSnapshot {
  entityType: "company" | "contact";
  primaryId: string;
  mergedId: string;
  primary: Record<string, unknown>;
  merged: Record<string, unknown>;
  reassigned: {
    contacts?: { id: string; previousCompanyId: string | null }[];
    deals?: { id: string; previousCompanyId: string | null }[];
    meetings?: { id: string; previousContactId?: string | null; previousCompanyId?: string | null }[];
    activities?: { id: string; previousEntityId: string }[];
    tasks?: { id: string; previousRelatedEntityId: string | null }[];
    calls?: { id: string; previousContactId: string | null }[];
  };
}

function rowToSnapshot(row: CompanyRow | ContactRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function pickFillableCompanyFields(primary: CompanyRow, merged: CompanyRow): Partial<CompanyRow> {
  const patch: Partial<CompanyRow> = { updatedAt: new Date() };
  if (!primary.domain?.trim() && merged.domain?.trim()) patch.domain = merged.domain;
  if (!primary.industry?.trim() && merged.industry?.trim()) patch.industry = merged.industry;
  if (primary.employeeCount == null && merged.employeeCount != null) patch.employeeCount = merged.employeeCount;
  if (primary.revenue == null && merged.revenue != null) patch.revenue = merged.revenue;
  if (!primary.location?.trim() && merged.location?.trim()) patch.location = merged.location;
  if (!primary.sourceProspectCompanyId?.trim() && merged.sourceProspectCompanyId?.trim()) {
    patch.sourceProspectCompanyId = merged.sourceProspectCompanyId;
  }
  return Object.keys(patch).length > 1 ? patch : { updatedAt: new Date() };
}

function pickFillableContactFields(primary: ContactRow, merged: ContactRow): Partial<ContactRow> {
  const patch: Partial<ContactRow> = { updatedAt: new Date() };
  if (!primary.lastName?.trim() && merged.lastName?.trim()) patch.lastName = merged.lastName;
  if (!primary.email?.trim() && merged.email?.trim()) patch.email = merged.email;
  if (!primary.phone?.trim() && merged.phone?.trim()) patch.phone = merged.phone;
  if (!primary.title?.trim() && merged.title?.trim()) patch.title = merged.title;
  if (!primary.linkedinUrl?.trim() && merged.linkedinUrl?.trim()) patch.linkedinUrl = merged.linkedinUrl;
  if (!primary.companyId && merged.companyId) patch.companyId = merged.companyId;
  if (!primary.sourceProspectId?.trim() && merged.sourceProspectId?.trim()) {
    patch.sourceProspectId = merged.sourceProspectId;
  }
  return Object.keys(patch).length > 1 ? patch : { updatedAt: new Date() };
}

async function loadCompany(db: Db, workspaceId: string, id: string): Promise<CompanyRow> {
  const [row] = await db
    .select()
    .from(companies)
    .where(scopedTo(companies, workspaceId, eq(companies.id, id), isNull(companies.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError("company_not_found", 404, { id });
  return row;
}

async function loadContact(db: Db, workspaceId: string, id: string): Promise<ContactRow> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(scopedTo(contacts, workspaceId, eq(contacts.id, id), isNull(contacts.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError("contact_not_found", 404, { id });
  return row;
}

/** §5.2 — apply a company merge: left survives, right is soft-deleted after FK reassignment. */
export async function applyCompanyMerge(
  db: Db,
  workspaceId: string,
  primaryId: string,
  mergedId: string
): Promise<IdentityMergeSnapshot> {
  if (primaryId === mergedId) throw new HttpError("invalid_merge_pair", 400);

  const primary = await loadCompany(db, workspaceId, primaryId);
  const merged = await loadCompany(db, workspaceId, mergedId);

  const snapshot: IdentityMergeSnapshot = {
    entityType: "company",
    primaryId,
    mergedId,
    primary: rowToSnapshot(primary),
    merged: rowToSnapshot(merged),
    reassigned: {},
  };

  await db.transaction(async (tx) => {
    const fill = pickFillableCompanyFields(primary, merged);
    await tx.update(companies).set(fill).where(eq(companies.id, primaryId));

    const contactRows = await tx
      .select({ id: contacts.id, companyId: contacts.companyId })
      .from(contacts)
      .where(
        scopedTo(contacts, workspaceId, eq(contacts.companyId, mergedId), isNull(contacts.deletedAt))
      );
    if (contactRows.length > 0) {
      snapshot.reassigned.contacts = contactRows.map((r) => ({ id: r.id, previousCompanyId: r.companyId }));
      for (const row of contactRows) {
        await tx.update(contacts).set({ companyId: primaryId, updatedAt: new Date() }).where(eq(contacts.id, row.id));
      }
    }

    const dealRows = await tx
      .select({ id: deals.id, companyId: deals.companyId })
      .from(deals)
      .where(scopedTo(deals, workspaceId, eq(deals.companyId, mergedId), isNull(deals.deletedAt)));
    if (dealRows.length > 0) {
      snapshot.reassigned.deals = dealRows.map((r) => ({ id: r.id, previousCompanyId: r.companyId }));
      for (const row of dealRows) {
        await tx.update(deals).set({ companyId: primaryId, updatedAt: new Date() }).where(eq(deals.id, row.id));
      }
    }

    const meetingRows = await tx
      .select({ id: meetings.id, companyId: meetings.companyId, contactId: meetings.contactId })
      .from(meetings)
      .where(scopedTo(meetings, workspaceId, eq(meetings.companyId, mergedId), isNull(meetings.deletedAt)));
    if (meetingRows.length > 0) {
      snapshot.reassigned.meetings = meetingRows.map((r) => ({
        id: r.id,
        previousCompanyId: r.companyId,
        previousContactId: r.contactId,
      }));
      for (const row of meetingRows) {
        await tx.update(meetings).set({ companyId: primaryId, updatedAt: new Date() }).where(eq(meetings.id, row.id));
      }
    }

    await tx
      .update(companies)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(companies.id, mergedId));
  });

  return snapshot;
}

/** §5.2 — apply a contact merge: left survives, right is soft-deleted after FK reassignment. */
export async function applyContactMerge(
  db: Db,
  workspaceId: string,
  primaryId: string,
  mergedId: string
): Promise<IdentityMergeSnapshot> {
  if (primaryId === mergedId) throw new HttpError("invalid_merge_pair", 400);

  const primary = await loadContact(db, workspaceId, primaryId);
  const merged = await loadContact(db, workspaceId, mergedId);

  const snapshot: IdentityMergeSnapshot = {
    entityType: "contact",
    primaryId,
    mergedId,
    primary: rowToSnapshot(primary),
    merged: rowToSnapshot(merged),
    reassigned: {},
  };

  await db.transaction(async (tx) => {
    const fill = pickFillableContactFields(primary, merged);
    await tx.update(contacts).set(fill).where(eq(contacts.id, primaryId));

    const activityRows = await tx
      .select({ id: activities.id, entityId: activities.entityId })
      .from(activities)
      .where(
        scopedTo(activities, workspaceId, eq(activities.entityType, "contact"), eq(activities.entityId, mergedId))
      );
    if (activityRows.length > 0) {
      snapshot.reassigned.activities = activityRows.map((r) => ({ id: r.id, previousEntityId: r.entityId }));
      for (const row of activityRows) {
        await tx.update(activities).set({ entityId: primaryId }).where(eq(activities.id, row.id));
      }
    }

    const taskRows = await tx
      .select({ id: tasks.id, relatedEntityId: tasks.relatedEntityId })
      .from(tasks)
      .where(
        scopedTo(tasks, workspaceId, eq(tasks.relatedEntityType, "contact"), eq(tasks.relatedEntityId, mergedId), isNull(tasks.deletedAt))
      );
    if (taskRows.length > 0) {
      snapshot.reassigned.tasks = taskRows.map((r) => ({ id: r.id, previousRelatedEntityId: r.relatedEntityId }));
      for (const row of taskRows) {
        await tx
          .update(tasks)
          .set({ relatedEntityId: primaryId, updatedAt: new Date() })
          .where(eq(tasks.id, row.id));
      }
    }

    const meetingRows = await tx
      .select({ id: meetings.id, contactId: meetings.contactId, companyId: meetings.companyId })
      .from(meetings)
      .where(scopedTo(meetings, workspaceId, eq(meetings.contactId, mergedId), isNull(meetings.deletedAt)));
    if (meetingRows.length > 0) {
      snapshot.reassigned.meetings = meetingRows.map((r) => ({
        id: r.id,
        previousContactId: r.contactId,
        previousCompanyId: r.companyId,
      }));
      for (const row of meetingRows) {
        await tx.update(meetings).set({ contactId: primaryId, updatedAt: new Date() }).where(eq(meetings.id, row.id));
      }
    }

    const callRows = await tx
      .select({ id: calls.id, contactId: calls.contactId })
      .from(calls)
      .where(scopedTo(calls, workspaceId, eq(calls.contactId, mergedId)));
    if (callRows.length > 0) {
      snapshot.reassigned.calls = callRows.map((r) => ({ id: r.id, previousContactId: r.contactId }));
      for (const row of callRows) {
        await tx.update(calls).set({ contactId: primaryId }).where(eq(calls.id, row.id));
      }
    }

    await tx
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(contacts.id, mergedId));
  });

  return snapshot;
}

export async function applyIdentityMerge(
  db: Db,
  workspaceId: string,
  entityType: string,
  primaryId: string,
  mergedId: string
): Promise<IdentityMergeSnapshot> {
  const result =
    entityType === "company"
      ? await applyCompanyMerge(db, workspaceId, primaryId, mergedId)
      : entityType === "contact"
        ? await applyContactMerge(db, workspaceId, primaryId, mergedId)
        : null;
  if (!result) throw new HttpError("unsupported_entity_type", 400, { entityType });
  try {
    const { incrJourneyMetric } = await import("./journey-metrics.js");
    incrJourneyMetric("identityMergeApply");
  } catch {
    /* ignore */
  }
  return result;
}

/** Restore entity rows and FK reassignments from a merge snapshot (reverse/split). */
export async function restoreIdentityMerge(db: Db, workspaceId: string, raw: unknown): Promise<void> {
  const snapshot = raw as IdentityMergeSnapshot;
  if (!snapshot?.entityType || !snapshot.primaryId || !snapshot.mergedId) {
    throw new HttpError("invalid_before_snapshot", 400);
  }

  await db.transaction(async (tx) => {
    if (snapshot.entityType === "company") {
      const primary = snapshot.primary as Partial<CompanyRow>;
      const merged = snapshot.merged as Partial<CompanyRow>;
      await tx
        .update(companies)
        .set({
          name: primary.name as string,
          domain: (primary.domain as string | null) ?? null,
          industry: (primary.industry as string | null) ?? null,
          employeeCount: (primary.employeeCount as number | null) ?? null,
          revenue: (primary.revenue as string | null) ?? null,
          location: (primary.location as string | null) ?? null,
          sourceProspectCompanyId: (primary.sourceProspectCompanyId as string | null) ?? null,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(scopedById(companies, workspaceId, snapshot.primaryId));

      await tx
        .update(companies)
        .set({
          name: merged.name as string,
          domain: (merged.domain as string | null) ?? null,
          industry: (merged.industry as string | null) ?? null,
          employeeCount: (merged.employeeCount as number | null) ?? null,
          revenue: (merged.revenue as string | null) ?? null,
          location: (merged.location as string | null) ?? null,
          sourceProspectCompanyId: (merged.sourceProspectCompanyId as string | null) ?? null,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(scopedById(companies, workspaceId, snapshot.mergedId));

      for (const row of snapshot.reassigned.contacts ?? []) {
        await tx
          .update(contacts)
          .set({ companyId: row.previousCompanyId, updatedAt: new Date() })
          .where(eq(contacts.id, row.id));
      }
      for (const row of snapshot.reassigned.deals ?? []) {
        await tx
          .update(deals)
          .set({ companyId: row.previousCompanyId, updatedAt: new Date() })
          .where(eq(deals.id, row.id));
      }
      for (const row of snapshot.reassigned.meetings ?? []) {
        await tx
          .update(meetings)
          .set({ companyId: row.previousCompanyId ?? null, updatedAt: new Date() })
          .where(eq(meetings.id, row.id));
      }
      return;
    }

    if (snapshot.entityType === "contact") {
      const primary = snapshot.primary as Partial<ContactRow>;
      const merged = snapshot.merged as Partial<ContactRow>;
      await tx
        .update(contacts)
        .set({
          firstName: primary.firstName as string,
          lastName: (primary.lastName as string | null) ?? null,
          email: (primary.email as string | null) ?? null,
          phone: (primary.phone as string | null) ?? null,
          title: (primary.title as string | null) ?? null,
          linkedinUrl: (primary.linkedinUrl as string | null) ?? null,
          companyId: (primary.companyId as string | null) ?? null,
          sourceProspectId: (primary.sourceProspectId as string | null) ?? null,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(scopedById(contacts, workspaceId, snapshot.primaryId));

      await tx
        .update(contacts)
        .set({
          firstName: merged.firstName as string,
          lastName: (merged.lastName as string | null) ?? null,
          email: (merged.email as string | null) ?? null,
          phone: (merged.phone as string | null) ?? null,
          title: (merged.title as string | null) ?? null,
          linkedinUrl: (merged.linkedinUrl as string | null) ?? null,
          companyId: (merged.companyId as string | null) ?? null,
          sourceProspectId: (merged.sourceProspectId as string | null) ?? null,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(scopedById(contacts, workspaceId, snapshot.mergedId));

      for (const row of snapshot.reassigned.activities ?? []) {
        await tx.update(activities).set({ entityId: row.previousEntityId }).where(eq(activities.id, row.id));
      }
      for (const row of snapshot.reassigned.tasks ?? []) {
        await tx
          .update(tasks)
          .set({ relatedEntityId: row.previousRelatedEntityId, updatedAt: new Date() })
          .where(eq(tasks.id, row.id));
      }
      for (const row of snapshot.reassigned.meetings ?? []) {
        await tx
          .update(meetings)
          .set({
            contactId: row.previousContactId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(meetings.id, row.id));
      }
      for (const row of snapshot.reassigned.calls ?? []) {
        await tx.update(calls).set({ contactId: row.previousContactId }).where(eq(calls.id, row.id));
      }
    }
  });
}
