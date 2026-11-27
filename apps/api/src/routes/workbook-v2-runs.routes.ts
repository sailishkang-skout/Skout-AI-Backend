import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema } from "@skout/db";
import { findRunTarget, notImplemented, type RunKind } from "../services/workbook-v2-runs.service.js";
import { WORKBOOK_RUN_PERMISSION, workbookRouteHelpers } from "./workbook-v2.common.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
// Strict: no client-supplied workspace, credit limit or provider choice.
const runBody = z
  .object({
    columnId: uuid,
    scope: z.enum(schema.WORKBOOK_RUN_SCOPES).default("all"),
    /** Only with scope "selected". */
    rowIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(10_000).optional(),
  })
  .strict()
  .refine((b) => (b.scope === "selected") === (b.rowIds !== undefined), { message: 'send rowIds with scope "selected", and only then', path: ["rowIds"] });

/**
 * The Workbooks V2 routes that execute a column (WB2-014), including pushes to a CRM. Every route here requires
 * `enrichment.run`, checked first, so someone without it learns nothing and changes nothing. The routes answer
 * 501 until the run engine exists.
 */
export async function workbookV2RunRoutes(app: FastifyInstance) {
  const { authorize, handle } = workbookRouteHelpers(app);

  const guarded = (kind: RunKind) =>
    handle(async (request) => {
      const { db, actor } = await authorize(request, WORKBOOK_RUN_PERMISSION);
      const { id } = idParams.parse(request.params);
      const { columnId, rowIds } = runBody.parse(request.body ?? {});
      await findRunTarget(db, actor.workspaceId, id, columnId, kind, rowIds);
      return notImplemented(kind);
    });

  app.post("/workbooks-v2/:id/runs", guarded("run"));
  app.post("/workbooks-v2/:id/crm-push", guarded("crm_push"));
}
