import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";

const { accountRelationships, companies } = schema;

export class AccountLinkError extends Error {
  constructor(
    public readonly code: "SAME_ACCOUNT" | "ACCOUNT_NOT_IN_WORKSPACE",
    message: string
  ) {
    super(message);
    this.name = "AccountLinkError";
  }
}

/**
 * Links two accounts in the same tenant. Both ids must exist in `workspaceId`; a cross-tenant id
 * is rejected here because the table's foreign keys alone do not stop it.
 * Returns the relationship id. A repeat of the same link returns the existing row.
 */
export async function linkAccounts(
  db: Db,
  input: { workspaceId: string; parentAccountId: string; childAccountId: string; relationship: string }
): Promise<string> {
  if (input.parentAccountId === input.childAccountId) {
    throw new AccountLinkError("SAME_ACCOUNT", "An account cannot be related to itself");
  }

  const found = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.workspaceId, input.workspaceId),
        inArray(companies.id, [input.parentAccountId, input.childAccountId])
      )
    );
  if (found.length !== 2) {
    throw new AccountLinkError("ACCOUNT_NOT_IN_WORKSPACE", "Both accounts must belong to this workspace");
  }

  const [row] = await db
    .insert(accountRelationships)
    .values({
      workspaceId: input.workspaceId,
      parentAccountId: input.parentAccountId,
      childAccountId: input.childAccountId,
      relationship: input.relationship,
    })
    .onConflictDoNothing()
    .returning({ id: accountRelationships.id });

  if (row) return row.id;
  const [existing] = await db
    .select({ id: accountRelationships.id })
    .from(accountRelationships)
    .where(
      and(
        eq(accountRelationships.workspaceId, input.workspaceId),
        eq(accountRelationships.parentAccountId, input.parentAccountId),
        eq(accountRelationships.childAccountId, input.childAccountId),
        eq(accountRelationships.relationship, input.relationship)
      )
    )
    .limit(1);
  return existing.id;
}
