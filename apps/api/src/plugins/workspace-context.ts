import type { FastifyReply, FastifyRequest } from "fastify";

export async function workspaceContext(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const headerWorkspaceId = request.headers["x-workspace-id"] as string | undefined;

  if (headerWorkspaceId) {
    request.workspaceId = headerWorkspaceId;
  }
  // request.workspaceId is already set by authPlugin from DB — no hardcoded fallback
}
