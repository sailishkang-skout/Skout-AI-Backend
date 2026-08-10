import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { errorResponse } from "../utils/http.js";

const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

export async function userRoutes(app: FastifyInstance) {
  app.get("/me", async (request, reply) => {
    let phone: string | null = null;
    if (app.db && request.userId) {
      const [row] = await app.db
        .select({ phone: schema.users.phone })
        .from(schema.users)
        .where(eq(schema.users.id, request.userId))
        .limit(1);
      phone = row?.phone ?? null;
    }
    return reply.send({
      userId: request.userId,
      email: request.userEmail,
      workspaceId: request.workspaceId,
      role: request.role,
      phone,
    });
  });

  // PATCH /me — currently just the R20.2 click-to-call agent phone number.
  app.patch<{ Body: { phone?: string | null } }>("/me", async (request, reply) => {
    if (!request.userId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(500).send(errorResponse("Database not available", 500));

    const { phone } = request.body ?? {};
    if (phone !== null && phone !== undefined) {
      if (typeof phone !== "string" || !PHONE_RE.test(phone.trim())) {
        return reply.code(400).send(errorResponse("phone must be E.164 format, e.g. +14155551234", 400));
      }
    }
    const normalized = phone && phone.trim() ? phone.trim() : null;
    await app.db.update(schema.users).set({ phone: normalized, updatedAt: new Date() }).where(eq(schema.users.id, request.userId));
    return reply.send({ data: { phone: normalized } });
  });
}
