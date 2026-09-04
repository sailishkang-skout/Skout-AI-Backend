import { crmSyncOwnedPatch, type CrmSyncEntityType } from "@skout/shared";
import { queueCrmOutboundWriteIfOwned } from "../crm-outbound-sync.service.js";
import { HttpError } from "../../utils/http.js";
import type { NodeHandler } from "./types.js";

/**
 * §8.14 SP-08 — a genuinely native external-CRM node, distinct from action_crm_writeback (which
 * only ever wrote to Skout's own internal `activities` table). Reuses Aditya's ADI-10 push-back
 * mechanism (queueCrmOutboundWriteIfOwned -> crm_outbound_writes -> crm-outbound-write.worker's
 * claim/lease/reclaim -> HubSpot's real update-contact/update-deal API) rather than opening a
 * second HubSpot-write path — see docs/adr/0009-hubspot-bidi-native-crm.md.
 *
 * Queuing is intentionally async/best-effort here too, matching every other caller of this
 * mechanism: no connected CRM, no linked record, or no CRM-sync-owned field in the patch are all
 * silent no-ops there, not errors, since a workflow author can't fix "this workspace has no
 * HubSpot connection" by editing the run.
 *
 * Config: { entityType: "contact" | "deal"; entityId: string; patch: Record<string, unknown> }.
 */
export const crmSyncActionNodeHandler: NodeHandler = async (ctx) => {
  const { entityType, entityId, patch } = ctx.node.config as {
    entityType?: CrmSyncEntityType;
    entityId?: string;
    patch?: Record<string, unknown>;
  };

  if (entityType !== "contact" && entityType !== "deal") {
    throw new HttpError('CRM sync action node requires entityType "contact" or "deal"', 422);
  }
  if (!entityId) {
    throw new HttpError("CRM sync action node requires entityId", 422);
  }

  const ownedPatch = crmSyncOwnedPatch(entityType, patch ?? {});

  if (ctx.isSimulation) {
    return { output: { simulated: true, entityType, entityId, ownedPatch } };
  }

  await queueCrmOutboundWriteIfOwned(ctx.db, ctx.workspaceId, entityType, entityId, patch ?? {});

  return { output: { entityType, entityId, ownedPatch, queued: Object.keys(ownedPatch).length > 0 } };
};
