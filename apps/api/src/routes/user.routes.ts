import type { FastifyInstance } from "fastify";

export async function userRoutes(app: FastifyInstance) {
  app.get("/me", async (request, reply) => {
    return reply.send({
      userId: request.userId,
      email: request.userEmail,
      workspaceId: request.workspaceId,
      role: request.role,
    });
  });
}
