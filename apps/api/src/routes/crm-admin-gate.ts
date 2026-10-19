import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getMemberPermissions, HttpError } from "@skout/auth";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { errorResponse } from "../utils/http.js";

/**
 * COPS-09: the CRM sync admin surface (opt-in, import, mappings, conflict queue, health, DLQ) is
 * for members who manage the workspace's integrations: workspace:manage, held by Owner and Admin.
 * Registered as a preHandler hook on each route plugin.
 */
export function crmAdminGate(app: FastifyInstance) {
  const gate = requireAnyCopsPermission(["workspace:manage"], (workspaceId, userId) => getMemberPermissions(app.db!, workspaceId, userId));
  // Without a database the routes answer 503 themselves; there are no permissions to read.
  return async (request: FastifyRequest, reply: FastifyReply) => (app.db ? gate(request, reply) : undefined);
}

/** Sends an HttpError as its status; returns false for any other error so the caller rethrows. */
export function sendHttpError(reply: FastifyReply, err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  void reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
  return true;
}
