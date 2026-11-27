import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WorkbookV2Error, findLiveWorkbook } from "../services/workbook-v2.service.js";
import { crmAccess } from "../services/workbook-crm-access.js";
import { MAX_CRM_FIELDS, createCrmImport } from "../services/workbook-crm.service.js";
import { describeApollo } from "../services/workbook-apollo.service.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

const idParams = z.object({ id: z.string().uuid() });

const apolloId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "an Apollo id");
const distinct = (values: string[]) => new Set(values).size === values.length;
/** Field names, the list and the stages are checked against what Apollo really has by the service. */
const apolloImportBody = z
  .object({
    fields: z.array(z.string().regex(/^[a-z_]{1,50}$/, "a field name")).min(1).max(MAX_CRM_FIELDS).refine(distinct, "name each field once"),
    listId: apolloId.optional(),
    search: z
      .object({
        keywords: z
          .string()
          .max(200)
          .refine((v) => !v.includes("\u0000"), "must not contain a NUL character")
          .optional(),
        stageIds: z.array(apolloId).max(20).refine(distinct, "name each stage once").optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((body) => (body.listId === undefined) !== (body.search === undefined), { path: ["listId"], message: "send either listId or search" });

/**
 * Apollo import (WB2-024), registered beside the other Workbooks V2 routes and behind the same `workbooks_v2` switch.
 * Everything here reads the workspace's Apollo contacts into a workbook, so all of it needs edit permission
 * (`enrichment:capture`). The key used is always the one saved for the session's workspace: no request names a
 * connection. A created import is then confirmed, followed and reported through the import routes (WB2-020).
 */
export async function workbookV2ApolloRoutes(app: FastifyInstance) {
  const { authorize, handle, handleOnce } = workbookRouteHelpers(app);

  app.get(
    "/workbooks-v2/:id/apollo-source",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      await findLiveWorkbook(db, actor.workspaceId, id);
      return { status: 200, body: { data: await describeApollo(crmAccess(db, app.config), actor.workspaceId) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/apollo-imports",
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      const { fields, listId, search } = apolloImportBody.parse(request.body ?? {});
      await findLiveWorkbook(db, actor.workspaceId, id);
      // The skipped-rows report is kept where imported files are.
      if (!importStorage(app.config)) throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, "Imports are not set up on this server.");
      const data = await createCrmImport(db, crmAccess(db, app.config), actor, id, { provider: "apollo", object: "contact", fields, viewId: listId, search });
      return { status: 201, body: { data } };
    })
  );
}
