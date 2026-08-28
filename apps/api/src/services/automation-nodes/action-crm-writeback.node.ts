import { schema } from "@skout/db";
import { HttpError } from "../../utils/http.js";
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

/**
 * Config: { entityType?: string; entityId: string; activityType?: string; subject?: string; body?: string }.
 * `entityType`/`activityType` default here rather than in the config panel — the panel only
 * *displays* "contact"/"note" as placeholder values, which aren't written into the saved graph
 * unless the user actually touches those fields, and both are NOT NULL columns with no
 * database-level default. `entityId` has no sensible default (it names a specific CRM record), so
 * a missing one fails fast with a clear error instead of a raw NOT NULL violation.
 *
 * activityType defaults to "note" specifically — the frontend's CRM timeline (activity-timeline.tsx)
 * only has icons/labels for its own closed ActivityType union (note/call/email/meeting/stage_change);
 * the column itself has no DB-level enum, so anything else renders as an unstyled fallback rather
 * than a real timeline entry (or, before that fallback existed, crashed the whole page).
 */
export const crmWritebackActionNodeHandler: NodeHandler = async (ctx) => {
  const { entityType = "contact", entityId, activityType = "note", subject, body } = ctx.node.config as {
    entityType?: string;
    entityId: string;
    activityType?: string;
    subject?: string;
    body?: string;
  };

  if (!entityId) {
    throw new HttpError("CRM writeback node is missing entityId — pick an existing contact/company/deal to log against", 422);
  }

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
