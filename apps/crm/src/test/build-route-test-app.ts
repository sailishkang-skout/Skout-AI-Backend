import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { HttpError } from "@skout/auth";
import { apiError } from "../utils/http.js";
import { registerRoutes } from "../routes/index.js";

const DEFAULT_WORKSPACE_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

/** Lightweight app for route unit tests — skips DB and Clerk. */
export async function buildRouteTestApp(
  workspaceId = DEFAULT_WORKSPACE_ID
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(
        apiError("validation_error", "Request validation failed", 400, {
          issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        })
      );
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send(
        apiError(error.message, error.message, error.statusCode, error.details ? { details: error.details } : undefined)
      );
    }

    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode) || 500
        : 500;

    request.log?.warn({ err: error }, "request error");
    const message = error instanceof Error ? error.message : "request_error";
    return reply.code(statusCode).send(apiError(message, message, statusCode));
  });

  app.addHook("preHandler", async (request) => {
    request.userId = "test-user-id";
    request.userEmail = "test@example.com";
    request.workspaceId = workspaceId;
    request.role = "owner";
  });

  await registerRoutes(app);
  return app;
}
