import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    workspaceId?: string;
  }
}

/** MVP tenant context — replace with JWT/session auth */
export async function workspaceContext(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const workspaceId = request.headers["x-workspace-id"] as string | undefined;

  request.workspaceId =
    workspaceId ?? "00000000-0000-4000-8000-000000000001";
}
