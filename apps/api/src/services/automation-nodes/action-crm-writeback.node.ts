import { schema } from "@skout/db";
import type { NodeHandler } from "./types.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md for the full audit and rationale; a new instance of the
 * same pattern the 9 confirmed cases there already cover.
 *   - Tables touched directly: activities (owned by apps/crm) - write only
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: buildCrmInternalClient() (crm-internal.client.ts) is read-only today — no write
 *     endpoints exist for activities yet — and an automation step writing a CRM timeline entry is
 *     a synchronous part of the run the author is watching execute, where an HTTP round trip into
 *     apps/crm would add latency without an internal API surface to call yet.
 *   - Review date: revisit once apps/crm's internal API surface covers activity writes (Wave 2)
 */
const { activities } = schema;

/** Config: { entityType: string; entityId: string; activityType: string; subject?: string; body?: string } */
export const crmWritebackActionNodeHandler: NodeHandler = async (ctx) => {
  const { entityType, entityId, activityType, subject, body } = ctx.node.config as {
    entityType: string;
    entityId: string;
    activityType: string;
    subject?: string;
    body?: string;
  };

  if (ctx.isSimulation) {
    return { output: { simulated: true, entityType, entityId, activityType } };
  }

  const [row] = await ctx.db
    .insert(activities)
    .values({
      workspaceId: ctx.workspaceId,
      entityType,
      entityId,
      activityType,
      subject: subject ?? `Workflow action: ${activityType}`,
      body: body ?? `Triggered by workflow run ${ctx.runId}`,
    })
    .returning();

  return { output: { activityId: row!.id } };
};
