import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, lte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import {
  buildCopsAuditRecord,
  copsPermissionKey,
  copsErrorBody,
  copsErrorStatus,
  resolveCorrelationId,
  type IdempotencyDecision,
  type CopsAuditInput,
  type CopsVerb,
  type CopsResource,
  type IdempotencyStore,
} from "@skout/shared";

const { copsIdempotencyKeys, auditLogs } = schema;

/** Postgres-backed Idempotency-Key store. Scope is the workspace id. */
export function copsIdempotencyStore(db: Db): IdempotencyStore {
  return {
    async reserve(scope, key, requestHash, now, pendingUntil): Promise<IdempotencyDecision> {
      const scopeId = scope;
      const inserted = await db
        .insert(copsIdempotencyKeys)
        .values({
          workspaceId: scopeId,
          key,
          requestHash,
          state: "pending",
          status: null,
          response: null,
          expiresAt: pendingUntil,
        })
        .onConflictDoNothing()
        .returning({ key: copsIdempotencyKeys.key });
      if (inserted.length > 0) return { kind: "reserved" };

      const reclaimed = await db
        .update(copsIdempotencyKeys)
        .set({ requestHash, state: "pending", status: null, response: null, expiresAt: pendingUntil })
        .where(
          and(
            eq(copsIdempotencyKeys.workspaceId, scopeId),
            eq(copsIdempotencyKeys.key, key),
            lte(copsIdempotencyKeys.expiresAt, now)
          )
        )
        .returning({ key: copsIdempotencyKeys.key });
      if (reclaimed.length > 0) return { kind: "reserved" };

      const [row] = await db
        .select()
        .from(copsIdempotencyKeys)
        .where(and(eq(copsIdempotencyKeys.workspaceId, scopeId), eq(copsIdempotencyKeys.key, key)))
        .limit(1);
      if (!row) throw new Error("Idempotency reservation disappeared during lookup");
      if (row.requestHash !== requestHash) return { kind: "conflict" };
      if (row.state === "complete" && row.status !== null) {
        return { kind: "replay", status: row.status, response: row.response };
      }
      return { kind: "in_progress" };
    },
    async complete(scope, key, requestHash, status, response, expiresAt) {
      const rows = await db
        .update(copsIdempotencyKeys)
        .set({ state: "complete", status, response, expiresAt })
        .where(
          and(
            eq(copsIdempotencyKeys.workspaceId, scope),
            eq(copsIdempotencyKeys.key, key),
            eq(copsIdempotencyKeys.requestHash, requestHash),
            eq(copsIdempotencyKeys.state, "pending")
          )
        )
        .returning({ key: copsIdempotencyKeys.key });
      if (rows.length === 0) throw new Error("Idempotency outcome could not be stored");
    },
    async release(scope, key, requestHash) {
      await db
        .delete(copsIdempotencyKeys)
        .where(
          and(
            eq(copsIdempotencyKeys.workspaceId, scope),
            eq(copsIdempotencyKeys.key, key),
            eq(copsIdempotencyKeys.requestHash, requestHash),
            eq(copsIdempotencyKeys.state, "pending")
          )
        );
    },
  };
}

/** Writes one Appendix D audit row. Validation runs first; an invalid event never reaches the DB. */
export async function writeCopsAudit(db: Pick<Db, "insert">, input: CopsAuditInput): Promise<void> {
  const record = buildCopsAuditRecord(input);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(record.tenantId) || !uuidPattern.test(record.entityId)) {
    throw new Error("Audit workspace and entity ids must be UUIDs");
  }
  if (record.actor.type === "user" && record.actor.id && !uuidPattern.test(record.actor.id)) {
    throw new Error("User audit actor id must be a UUID");
  }
  await db.insert(auditLogs).values({
    workspaceId: record.tenantId,
    actorId: record.actor.type === "user" ? record.actor.id : null,
    actorType: record.actor.type,
    actorRef: record.actor.id,
    impersonatorId: record.impersonatorId ?? null,
    entityType: record.entityType,
    entityId: record.entityId,
    action: record.action,
    beforeState: (record.before ?? null) as Record<string, unknown> | null,
    afterState: (record.after ?? null) as Record<string, unknown> | null,
    reason: record.reason ?? null,
    isOverride: record.override ?? false,
    correlationId: record.correlationId,
    sourceChannel: record.sourceChannel,
    createdAt: record.occurredAt,
  });
}

/**
 * Fastify preHandler for COPS routes. Uses the existing permission lookup and returns the COPS
 * error envelope on denial. `getPermissions` is injected so the rule can be tested without a DB.
 */
export function requireCopsPermission(
  resource: CopsResource,
  verb: CopsVerb,
  getPermissions: (workspaceId: string, userId: string) => Promise<string[]>
) {
  const required = copsPermissionKey(resource, verb);
  return async function copsPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const workspaceId = request.workspaceId;
    const userId = request.userId;
    if (!workspaceId || !userId) {
      return reply
        .status(401)
        .send(copsErrorBody({ code: "UNAUTHENTICATED", message: "Missing workspace context", requestId }));
    }
    const granted = await getPermissions(workspaceId, userId);
    if (!granted.includes(required)) {
      return reply.status(copsErrorStatus("FORBIDDEN")).send(
        copsErrorBody({
          code: "FORBIDDEN",
          message: "You do not have permission for this action",
          requestId,
          details: { required_permission: required },
        })
      );
    }
  };
}
