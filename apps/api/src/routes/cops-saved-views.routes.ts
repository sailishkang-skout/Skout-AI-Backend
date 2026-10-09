import type { FastifyInstance } from "fastify";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";

const { copsSavedViews } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_TYPES = ["account", "contact", "opportunity", "task"] as const;

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    object: z.enum(OBJECT_TYPES),
    filters: z.record(z.unknown()).default({}),
    sort: z.string().trim().max(60).optional(),
    shared: z.boolean().default(false),
  })
  .strict();

/**
 * COPS-02 saved views. Anyone with CRM read reach can list their own and shared views; only the
 * owner of a view can delete it. Filters are stored as-is and applied by the list endpoints.
 */
export async function copsSavedViewsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const readGate = requireAnyCopsPermission(["crm:read", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  const writeGate = requireAnyCopsPermission(["crm:write", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));

  const fail = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }, requestId: string, code: "VALIDATION_FAILED" | "NOT_FOUND" | "FORBIDDEN", message: string, path?: string) =>
    reply.status(code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? copsErrorStatus("FORBIDDEN") : copsErrorStatus("VALIDATION_FAILED")).send(
      copsErrorBody({
        code,
        message,
        requestId,
        details: path ? { fields: [{ path, code: "invalid", message }] } : {},
      })
    );

  app.get<{ Querystring: { object?: string } }>("/saved-views", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const object = request.query.object;
    if (object && !(OBJECT_TYPES as readonly string[]).includes(object)) {
      return fail(reply, requestId, "VALIDATION_FAILED", "Unknown object type", "object");
    }
    const rows = await db
      .select()
      .from(copsSavedViews)
      .where(
        and(
          eq(copsSavedViews.workspaceId, request.workspaceId!),
          or(eq(copsSavedViews.ownerUserId, request.userId!), eq(copsSavedViews.shared, true)),
          ...(object ? [eq(copsSavedViews.objectType, object)] : [])
        )
      )
      .orderBy(desc(copsSavedViews.updatedAt));
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        object: r.objectType,
        filters: r.filters,
        sort: r.sort,
        shared: r.shared,
        owner_user_id: r.ownerUserId,
        mine: r.ownerUserId === request.userId,
        updated_at: r.updatedAt.toISOString(),
      })),
    };
  });

  app.post<{ Body: unknown }>("/saved-views", { preHandler: writeGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return fail(reply, requestId, "VALIDATION_FAILED", first?.message ?? "Invalid saved view", first?.path.join(".") || undefined);
    }
    const [row] = await db
      .insert(copsSavedViews)
      .values({
        workspaceId: request.workspaceId!,
        ownerUserId: request.userId!,
        name: parsed.data.name,
        objectType: parsed.data.object,
        filters: parsed.data.filters,
        sort: parsed.data.sort ?? null,
        shared: parsed.data.shared,
      })
      .returning({ id: copsSavedViews.id });
    return reply.status(201).send({ data: { id: row.id } });
  });

  app.delete<{ Params: { id: string } }>("/saved-views/:id", { preHandler: writeGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    if (!UUID.test(request.params.id)) return fail(reply, requestId, "VALIDATION_FAILED", "Invalid view id", "id");
    const [view] = await db
      .select({ id: copsSavedViews.id, ownerUserId: copsSavedViews.ownerUserId })
      .from(copsSavedViews)
      .where(and(eq(copsSavedViews.id, request.params.id), eq(copsSavedViews.workspaceId, request.workspaceId!)))
      .limit(1);
    if (!view) return fail(reply, requestId, "NOT_FOUND", "Saved view not found");
    if (view.ownerUserId !== request.userId) {
      return fail(reply, requestId, "FORBIDDEN", "Only the owner can delete this saved view");
    }
    await db.delete(copsSavedViews).where(eq(copsSavedViews.id, view.id));
    return reply.status(204).send();
  });
}
