import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { SearchService } from "./search.service.js";

const { enrichmentResults, prospectActivations } = schema;

export interface ResolvedProspect {
  prospectId: string;
  email?: string;
  firstName: string;
  lastName: string;
  fullName: string;
  companyName?: string;
  companyDomain?: string;
  title?: string;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

/**
 * Resolves a prospectId to the fields needed for merge tokens + the send-to address.
 * Email precedence mirrors crm-export.runner.ts: activation snapshot > enrichmentResults > OpenSearch doc.
 */
export async function resolveProspectFields(
  env: Env,
  db: Db,
  workspaceId: string,
  prospectId: string
): Promise<ResolvedProspect | null> {
  const search = new SearchService(env);
  // OpenSearch lookup — may return null for manually-created prospects
  const doc = await search.findExistingProspect(prospectId).catch(() => null);

  const [activation] = await db
    .select()
    .from(prospectActivations)
    .where(
      and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId))
    );
  const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;

  // If no OpenSearch doc AND no activation snapshot, prospect is unresolvable
  if (!doc && !activation) return null;

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

  const snapshotEmail = str(snap.email);
  const snapshotFullName = str(snap.fullName);
  const snapshotFirstName = str(snap.firstName);
  const snapshotLastName = str(snap.lastName);

  let enrichedEmail: string | undefined;
  if (!snapshotEmail) {
    const rows = await db
      .select({ fieldValue: enrichmentResults.fieldValue, isPrimary: enrichmentResults.isPrimary })
      .from(enrichmentResults)
      .where(
        and(
          eq(enrichmentResults.workspaceId, workspaceId),
          inArray(enrichmentResults.prospectId, [prospectId]),
          eq(enrichmentResults.fieldName, "email")
        )
      )
      .orderBy(desc(enrichmentResults.createdAt));
    const primary = rows.find((r) => r.isPrimary && r.fieldValue);
    enrichedEmail = primary?.fieldValue ?? rows.find((r) => r.fieldValue)?.fieldValue ?? undefined;
  }

  const email = snapshotEmail ?? enrichedEmail ?? doc?.email ?? undefined;
  const fullName = doc?.fullName ?? snapshotFullName ?? "";
  const { firstName, lastName } = snapshotFirstName
    ? { firstName: snapshotFirstName, lastName: snapshotLastName ?? "" }
    : splitName(fullName);

  return {
    prospectId,
    email,
    firstName,
    lastName,
    fullName,
    companyName: doc?.companyName ?? str(snap.companyName) ?? undefined,
    companyDomain: doc?.companyDomain ?? str(snap.companyDomain) ?? undefined,
    title: doc?.title || str(snap.title) || undefined,
  };
}
