import { verifyToken } from "@clerk/backend";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { resolveOrProvisionUser } from "../services/auth.service.js";
import { errorResponse, HttpError } from "../utils/http.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
    workspaceId?: string;
    role?: string;
  }
}

export const authPlugin = fp(async (app) => {
  const config = app.config;

  if (!config.CLERK_SECRET_KEY) {
    app.log.warn("CLERK_SECRET_KEY not set — auth middleware disabled (dev stub mode)");
    return;
  }

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/api/v1/health" || request.url.startsWith("/health")) {
      return;
    }

    const db = app.db;
    if (!db) {
      return reply.code(500).send(errorResponse("Database not available", 500));
    }

    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;

    if (!token) {
      return reply.code(401).send(errorResponse("Missing bearer token", 401));
    }

    try {
      const claims = await verifyToken(token, { secretKey: config.CLERK_SECRET_KEY });

      const clerkUserId = claims?.sub;
      if (!clerkUserId) {
        return reply.code(401).send(errorResponse("Invalid Clerk token", 401));
      }

      const email = String(claims.email ?? `${clerkUserId}@clerk.local`);
      const fullName = String(claims.name ?? claims.first_name ?? email);

      const result = await resolveOrProvisionUser(db, clerkUserId, email, fullName);

      request.userId = result.userId;
      request.userEmail = result.userEmail;
      request.workspaceId = result.workspaceId;
      request.role = result.role;
    } catch (error) {
      app.log.error({ err: error }, "Auth failed");
      const status = error instanceof HttpError ? error.statusCode : 401;
      const message = error instanceof Error ? error.message : "Invalid authorization token";
      return reply.code(status).send(errorResponse(message, status));
    }
  });
});
