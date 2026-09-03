import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * §11.1 — ADI-04/ADI-05 tenant-scoping consolidation. See
 * docs/superpowers/specs/2026-09-02-tenant-scoping-consolidation-design.md for the full
 * investigation this implements.
 *
 * Today, every workspace-scoped query is hand-written as
 * `and(eq(table.workspaceId, workspaceId), ...)` independently per call site, in both this
 * repo's apps/api and apps/crm (which duplicates the pattern entirely separately — see the
 * design doc §2.5). That's correct everywhere it was sampled, but nothing enforces it, so a
 * missed filter on a new query is a silent cross-tenant leak, not a compile error.
 *
 * These helpers don't replace Drizzle's query builder — they just make the tenant filter a
 * required, typed argument instead of something a call site can forget. `workspaceId` is a
 * required positional argument specifically so a query can't be constructed without one.
 *
 * This lives in packages/db (not apps/api) so apps/crm can adopt it too — a helper only one
 * service can import fixes half the platform, per the design doc's core finding.
 */

interface WorkspaceScopedTable {
  workspaceId: PgColumn;
}

interface WorkspaceScopedTableWithId extends WorkspaceScopedTable {
  id: PgColumn;
}

/**
 * A WHERE condition scoping `table` to `workspaceId`, AND-ed with any additional conditions.
 * Use for list/filter queries: `db.select().from(t).where(scopedTo(t, workspaceId, eq(t.status, "active")))`.
 *
 * `workspaceId` also accepts a `PgColumn` — not just a literal string — so a join can scope the
 * joined table to the *anchor* row's workspace rather than a known value, e.g.
 * `.leftJoin(prospectActivations, scopedTo(prospectActivations, aiDrafts.workspaceId, eq(...)))`
 * asserts the joined row belongs to the same workspace as `aiDrafts`, which is exactly the kind
 * of tenant check this helper exists to make impossible to accidentally omit.
 */
export function scopedTo<T extends WorkspaceScopedTable>(
  table: T,
  workspaceId: string | PgColumn,
  ...rest: Array<SQL | undefined>
): SQL {
  const conditions: SQL[] = [eq(table.workspaceId, workspaceId)];
  for (const r of rest) {
    if (r) conditions.push(r);
  }
  // `and(...)` only returns undefined when called with zero conditions — impossible here since
  // conditions always has at least the workspaceId equality.
  return and(...conditions)!;
}

/**
 * A WHERE condition for the single most common shape: "fetch/update/delete this one row, and
 * it must belong to this workspace." Use for get-by-id/update/delete call sites:
 * `db.select().from(t).where(scopedById(t, workspaceId, id))`.
 *
 * Both `workspaceId` and `id` also accept a `PgColumn` for the same join-condition reason as
 * `scopedTo` — e.g. `.innerJoin(lists, scopedById(lists, workspaceId, listMembers.listId))`.
 */
export function scopedById<T extends WorkspaceScopedTableWithId>(
  table: T,
  workspaceId: string | PgColumn,
  id: string | PgColumn
): SQL {
  return and(eq(table.id, id), eq(table.workspaceId, workspaceId))!;
}
