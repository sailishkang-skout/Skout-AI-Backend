import { SequenceService } from "../sequence.service.js";
import type { NodeHandler } from "./types.js";

/** Config: { sequenceId: string; prospectId: string } */
export const sequenceEnrollActionNodeHandler: NodeHandler = async (ctx) => {
  const { sequenceId, prospectId } = ctx.node.config as { sequenceId: string; prospectId: string };

  if (ctx.isSimulation) {
    return { output: { simulated: true, sequenceId, prospectId } };
  }

  const svc = new SequenceService(ctx.db);
  const result = await svc.enroll(sequenceId, ctx.workspaceId, { prospectIds: [prospectId] });
  return {
    output: {
      enrolled: result.enrolled,
      skipped: result.skipped,
      enrollmentId: result.newEnrollments[0]?.enrollmentId ?? null,
    },
  };
};
