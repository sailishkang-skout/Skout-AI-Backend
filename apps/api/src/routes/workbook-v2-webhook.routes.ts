import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findLiveWorkbook } from "../services/workbook-v2.service.js";
import { createWebhook, getWebhook, regenerateWebhookToken, updateWebhook } from "../services/workbook-webhook.service.js";
import { DEDUPE_KEYS } from "../services/workbook-import-plan.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const noBody = z.object({}).strict();
const changeBody = z
  .object({ enabled: z.boolean().optional(), dedupe: z.object({ key: z.enum(DEDUPE_KEYS), columnId: uuid.optional() }).strict().optional() })
  .strict()
  .refine((b) => b.enabled !== undefined || b.dedupe !== undefined, "send enabled or dedupe");

/**
 * Managing a workbook's inbound webhook (WB2-026), behind the `workbooks_v2` switch like the other Workbooks V2 routes.
 * Seeing its status is viewing the workbook; making, replacing, turning on or off and configuring it is editing
 * (`enrichment:capture`). A token appears only in the answer that made it. Those answers are deliberately not kept for
 * idempotent replay, which would store the token.
 */
export async function workbookV2WebhookRoutes(app: FastifyInstance) {
  const { authorize, handle } = workbookRouteHelpers(app);
  const secret = { "cache-control": "no-store" };

  app.get(
    "/workbooks-v2/:id/webhook",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await getWebhook(db, app.config, actor.workspaceId, id) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/webhook",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      noBody.parse(request.body ?? {});
      await findLiveWorkbook(db, actor.workspaceId, id);
      return { status: 201, headers: secret, body: { data: await createWebhook(db, app.config, actor, id) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/webhook/regenerate",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      noBody.parse(request.body ?? {});
      return { status: 200, headers: secret, body: { data: await regenerateWebhookToken(db, app.config, actor, id) } };
    })
  );

  app.patch(
    "/workbooks-v2/:id/webhook",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      const change = changeBody.parse(request.body ?? {});
      return { status: 200, body: { data: await updateWebhook(db, app.config, actor, id, change) } };
    })
  );
}
