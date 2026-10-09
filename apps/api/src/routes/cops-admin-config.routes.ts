import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, isCopsConfigKind, resolveCorrelationId, type CopsConfigKind } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import { AdminConfigError, listConfig, listConfigVersions, rollbackConfig, saveConfig } from "../services/cops-admin-config.service.js";

const saveSchema = z
  .object({
    value: z.record(z.unknown()),
    reason: z.string().trim().min(1, "reason is required").max(1000),
    expected_version: z.number().int().min(0).optional(),
  })
  .strict();
const rollbackSchema = z.object({ version: z.number().int().min(1), reason: z.string().trim().min(1, "reason is required").max(1000) }).strict();

type Reply = CopsCapturingReply;
type KindParams = { Params: { kind: string }; Body: unknown };
type KeyParams = { Params: { kind: string; key: string }; Body: unknown };

/**
 * COPS-07 admin configuration. Contract: docs/api/copos-07-admin.openapi.yaml.
 * Reads need admin:read (Product holds it), writes need admin:admin. Every write is a new version
 * with a reason and an audit row.
 */
export async function copsAdminConfigRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const readGate = requireAnyCopsPermission(["admin:read", "admin:admin"], perms);
  const writeGate = requireAnyCopsPermission(["admin:admin"], perms);
  const idempotency = copsIdempotencyStore(db);

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });

  function invalid(reply: Reply, requestId: string, error: z.ZodError | { path: string; message: string }) {
    const fields =
      error instanceof z.ZodError
        ? error.issues.map((i) => ({ path: i.path.join(".") || "body", code: i.code, message: i.message }))
        : [{ path: error.path, code: "invalid", message: error.message }];
    return reply
      .status(copsErrorStatus("VALIDATION_FAILED"))
      .send(copsErrorBody({ code: "VALIDATION_FAILED", message: fields[0]?.message ?? "Invalid request", requestId, details: { fields } }));
  }

  const kindOf = (reply: Reply, requestId: string, kind: string): CopsConfigKind | null => {
    if (isCopsConfigKind(kind)) return kind;
    invalid(reply, requestId, { path: "kind", message: "Unknown configuration kind" });
    return null;
  };

  async function run<T>(reply: Reply, requestId: string, fn: () => Promise<T>, onOk: (value: T) => unknown) {
    try {
      return onOk(await fn());
    } catch (error) {
      if (error instanceof AdminConfigError) {
        return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details }));
      }
      throw error;
    }
  }

  app.get<KindParams>("/admin/config/:kind", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    const kind = kindOf(reply, ctx.requestId, request.params.kind);
    if (!kind) return;
    return run(reply, ctx.requestId, () => listConfig(db, ctx.workspaceId, kind), (data) => ({ data }));
  });

  app.get<KeyParams>("/admin/config/:kind/:key/versions", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    const kind = kindOf(reply, ctx.requestId, request.params.kind);
    if (!kind) return;
    return run(reply, ctx.requestId, () => listConfigVersions(db, ctx.workspaceId, kind, request.params.key), (data) => ({ data }));
  });

  app.put<KeyParams>(
    "/admin/config/:kind/:key",
    { preHandler: writeGate },
    withCopsIdempotentReply<KeyParams>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const kind = kindOf(reply, ctx.requestId, request.params.kind);
      if (!kind) return;
      const parsed = saveSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => saveConfig(db, ctx, kind, request.params.key, parsed.data), (data) => reply.status(201).send({ data }));
    })
  );

  app.post<KeyParams>(
    "/admin/config/:kind/:key/rollback",
    { preHandler: writeGate },
    withCopsIdempotentReply<KeyParams>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const kind = kindOf(reply, ctx.requestId, request.params.kind);
      if (!kind) return;
      const parsed = rollbackSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => rollbackConfig(db, ctx, kind, request.params.key, parsed.data), (data) => reply.status(201).send({ data }));
    })
  );
}
