import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { upsertCompanyBySourceProspect, upsertContactBySourceProspect, type ProspectSnapshotPreview } from "./upsert.js";

const { lists, listMembers, prospectActivations, auditLogs } = schema;

export interface ImportListResult {
  imported: number;
  created: number;
  updated: number;
}

/**
 * Imports every member of an apps/api List into the CRM as Company+Contact records, matched by
 * the same sourceProspectId/sourceProspectCompanyId correlation key promoteProspectToDeal() uses.
 * No Deal is created — this only populates the address book. Idempotent: re-running updates
 * existing linked records rather than duplicating them.
 */
export async function importListToCrm(
  db: Db,
  workspaceId: string,
  listId: string,
  actorId: string | undefined
): Promise<ImportListResult> {
  const [list] = await db
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)))
    .limit(1);
  if (!list) throw new Error("list_not_found");

  const members = await db
    .select({ prospectId: listMembers.prospectId, snapshot: prospectActivations.snapshot })
    .from(listMembers)
    .leftJoin(
      prospectActivations,
      and(
        eq(prospectActivations.workspaceId, workspaceId),
        eq(prospectActivations.prospectId, listMembers.prospectId)
      )
    )
    .where(eq(listMembers.listId, listId));

  let created = 0;
  let updated = 0;

  await db.transaction(async (tx) => {
    for (const member of members) {
      const snapshot = (member.snapshot ?? {}) as ProspectSnapshotPreview;

      const { companyId, created: companyCreated, row: companyRow } = await upsertCompanyBySourceProspect(
        tx,
        workspaceId,
        member.prospectId,
        snapshot
      );
      if (companyCreated) {
        await tx.insert(auditLogs).values({
          workspaceId,
          actorId: actorId ?? null,
          action: "import",
          entityType: "company",
          entityId: companyId,
          beforeState: null,
          afterState: companyRow,
        });
        created++;
      } else {
        updated++;
      }

      const { contactId, created: contactCreated, row: contactRow } = await upsertContactBySourceProspect(
        tx,
        workspaceId,
        member.prospectId,
        companyId,
        snapshot
      );
      if (contactCreated) {
        await tx.insert(auditLogs).values({
          workspaceId,
          actorId: actorId ?? null,
          action: "import",
          entityType: "contact",
          entityId: contactId,
          beforeState: null,
          afterState: contactRow,
        });
        created++;
      } else {
        updated++;
      }
    }
  });

  return { imported: members.length, created, updated };
}
