import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, or } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { copsErrorBody, resolveCorrelationId } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * COPS-14 part C: data scope. A member can be limited to their own accounts, meaning accounts
 * whose owner or CSM they are. No row in cops_member_data_scopes means no limit.
 *
 * The limit is enforced once, by a v1 preHandler on every `/accounts/:id/...` and
 * `/account-360/:id` route: a limited member gets 404 for any other account, so it does not even
 * learn that the account exists. Lists and dashboards are not covered yet (see the PR).
 *
 * DOCUMENTED READ-MODEL EXCEPTION (docs/adr/0003-read-model-exceptions.md, COPS-14 row).
 *   - Tables touched directly: companies (read owner_id and csm_id)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the check runs before every account read; an HTTP round trip per request would
 *     double the latency of every Customer 360 call
 *   - Review date: revisit when apps/crm exposes an account-ownership lookup
 */
const { companies, copsMemberDataScopes, workspaceMembers } = schema;

export const DATA_SCOPES = ["all", "own_accounts"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export class DataScopeError extends Error {
  constructor(
    public code: "NOT_FOUND" | "BUSINESS_STATE_CONFLICT",
    message: string
  ) {
    super(message);
  }
  get status() {
    return this.code === "NOT_FOUND" ? 404 : 409;
  }
}

export async function getDataScope(db: Db, workspaceId: string, userId: string): Promise<DataScope> {
  const [row] = await db
    .select({ scope: copsMemberDataScopes.scope })
    .from(copsMemberDataScopes)
    .where(and(eq(copsMemberDataScopes.workspaceId, workspaceId), eq(copsMemberDataScopes.userId, userId)))
    .limit(1);
  return row?.scope === "own_accounts" ? "own_accounts" : "all";
}

/** True when the member may see this account under their scope. Unknown accounts are left to the route. */
export async function canSeeAccount(db: Db, workspaceId: string, userId: string, accountId: string): Promise<boolean> {
  if ((await getDataScope(db, workspaceId, userId)) === "all") return true;
  const [acc] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.id, accountId), or(eq(companies.ownerId, userId), eq(companies.csmId, userId))))
    .limit(1);
  return Boolean(acc);
}

const ACCOUNT_ROUTE = /^\/api\/v1\/(accounts|account-360)\/:(id|companyId)(\/|$)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** v1 preHandler: a member limited to their own accounts gets 404 on any other account's routes. */
export function accountScopeGuard(db: Db) {
  return async function accountScope(request: FastifyRequest, reply: FastifyReply) {
    const route = request.routeOptions?.url ?? "";
    const match = ACCOUNT_ROUTE.exec(route);
    if (!match || !request.workspaceId || !request.userId) return;
    const accountId = (request.params as Record<string, string | undefined>)[match[2]!];
    if (!accountId || !UUID.test(accountId)) return;
    if (await canSeeAccount(db, request.workspaceId, request.userId, accountId)) return;
    return reply
      .status(404)
      .send(copsErrorBody({ code: "NOT_FOUND", message: "Account not found", requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined) }));
  };
}

export async function setDataScope(
  db: Db,
  ctx: { workspaceId: string; userId: string; requestId: string },
  userId: string,
  scope: DataScope,
  reason: string
) {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!member) throw new DataScopeError("NOT_FOUND", "Not a member of this workspace");
  // An owner always sees everything, so nobody can lock the workspace out of its own accounts.
  if (scope !== "all" && member.role === "owner") throw new DataScopeError("BUSINESS_STATE_CONFLICT", "An owner cannot be limited to their own accounts");
  const before = await getDataScope(db, ctx.workspaceId, userId);
  await db.transaction(async (tx) => {
    if (scope === "all") {
      await tx.delete(copsMemberDataScopes).where(and(eq(copsMemberDataScopes.workspaceId, ctx.workspaceId), eq(copsMemberDataScopes.userId, userId)));
    } else {
      await tx
        .insert(copsMemberDataScopes)
        .values({ workspaceId: ctx.workspaceId, userId, scope, setBy: ctx.userId, reason: reason.trim() })
        .onConflictDoUpdate({ target: [copsMemberDataScopes.workspaceId, copsMemberDataScopes.userId], set: { scope, setBy: ctx.userId, reason: reason.trim(), updatedAt: new Date() } });
    }
    await writeCopsAudit(tx as never, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "workspace_member",
      entityId: userId,
      action: "member.data_scope_updated",
      before: { scope: before },
      after: { scope },
      reason: reason.trim(),
      correlationId: ctx.requestId,
      sourceChannel: "web",
    });
  });
  return { user_id: userId, scope };
}

/** Accounts a limited member may see, for list filters (owner or CSM). Null means no limit. */
export function ownAccountsCondition(scope: DataScope, userId: string) {
  return scope === "own_accounts" ? or(eq(companies.ownerId, userId), eq(companies.csmId, userId))! : null;
}

