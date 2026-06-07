import type { FastifyInstance } from "fastify";
import { enrollSequenceSchema } from "@skout/shared";
import { sequenceService } from "../services/sequence.service.js";

export async function sequenceRoutes(app: FastifyInstance) {
  app.get("/sequences", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await sequenceService.list(workspaceId));
  });

  app.post("/sequences/:id/enroll", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    enrollSequenceSchema.parse(request.body ?? {});
    const result = await sequenceService.enroll(id, workspaceId);
    return reply.status(202).send(result);
  });
}
