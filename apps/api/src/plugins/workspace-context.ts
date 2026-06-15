import type { FastifyReply, FastifyRequest } from "fastify";

export async function workspaceContext(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const headerWorkspaceId = request.headers["x-workspace-id"] as string | undefined;

  // JWT auth sets workspaceId from the user's provisioned tenant — don't override with a header.
  if (headerWorkspaceId && !request.workspaceId) {
    request.workspaceId = headerWorkspaceId;
  }
}
