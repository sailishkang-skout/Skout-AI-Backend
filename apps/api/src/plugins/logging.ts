import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";
import { enterRequestContext, patchRequestContext, setSentryUser } from "@skout/observability";

const REQUEST_ID_HEADER = "x-request-id";

export const loggingPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const incoming =
      (typeof request.headers[REQUEST_ID_HEADER] === "string"
        ? request.headers[REQUEST_ID_HEADER]
        : undefined) ?? randomUUID();

    reply.header(REQUEST_ID_HEADER, incoming);

    enterRequestContext({
      requestId: incoming,
      method: request.method,
      path: request.url.split("?")[0],
    });

    request.log = request.log.child({
      requestId: incoming,
      module: "http",
    });
  });

  app.addHook("preHandler", async (request: FastifyRequest) => {
    patchRequestContext({
      userId: request.userId,
      workspaceId: request.workspaceId,
    });

    if (request.userId) {
      setSentryUser({
        id: request.userId,
        email: request.userEmail,
        workspaceId: request.workspaceId,
      });
    }

    request.log = request.log.child({
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
    });
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    request.log.info(
      {
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "request completed"
    );
  });
});
