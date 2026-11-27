import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { loadWorkspaceAccess } from "@skout/auth";
import { WorkbookV2Error, findLiveWorkbook } from "../services/workbook-v2.service.js";
import { crmAccess } from "../services/workbook-crm-access.js";
import { CRM_OBJECTS, MAX_CRM_FIELDS, createCrmImport, describeCrmObject, listCrmSources } from "../services/workbook-crm.service.js";
import { CRM_PROVIDERS } from "../services/workbook-v2-column-config.js";
import { CRM_OPERATORS } from "../services/crm-record-source.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const objectParams = z.object({ id: uuid, provider: z.enum(CRM_PROVIDERS), object: z.enum(CRM_OBJECTS) });

/** Names and values are checked against what the CRM really has by the service. */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\u0000"), "must not contain a NUL character");
const crmImportBody = z
  .object({
    provider: z.enum(CRM_PROVIDERS),
    object: z.enum(CRM_OBJECTS),
    fields: z
      .array(text(200))
      .min(1)
      .max(MAX_CRM_FIELDS)
      .refine((f) => new Set(f).size === f.length, "name each field once"),
    viewId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "a view id").optional(),
    filters: z
      .array(z.object({ field: text(200), operator: z.enum(CRM_OPERATORS), value: text(500).optional() }).strict())
      .max(20)
      .optional(),
  })
  .strict();

/** Reading a CRM also needs CRM to be part of the workspace's plan, as connecting it does. */
export async function assertCrmFeature(db: Db, workspaceId: string): Promise<void> {
  const access = await loadWorkspaceAccess(db, workspaceId);
  if (!access.features.crm) throw new WorkbookV2Error("CRM_NOT_AVAILABLE", 403, "CRM isn't included in this workspace's plan.", { feature: "crm" });
}

/**
 * CRM import (WB2-023), registered beside the other Workbooks V2 routes and behind the same `workbooks_v2` switch.
 * Everything here reads someone's CRM into a workbook, so all of it needs edit permission (`enrichment:capture`). The
 * connection used is always the session workspace's own: no request names one. A created import is then confirmed,
 * followed and reported through the import routes (WB2-020).
 */
export async function workbookV2CrmRoutes(app: FastifyInstance) {
  const { authorize, handle, handleOnce } = workbookRouteHelpers(app);

  app.get(
    "/workbooks-v2/:id/crm-sources",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      await findLiveWorkbook(db, actor.workspaceId, id);
      await assertCrmFeature(db, actor.workspaceId);
      return { status: 200, body: { data: await listCrmSources(crmAccess(db, app.config), actor.workspaceId) } };
    })
  );

  app.get(
    "/workbooks-v2/:id/crm-sources/:provider/:object",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, provider, object } = objectParams.parse(request.params);
      await findLiveWorkbook(db, actor.workspaceId, id);
      await assertCrmFeature(db, actor.workspaceId);
      return { status: 200, body: { data: await describeCrmObject(crmAccess(db, app.config), actor.workspaceId, provider, object) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/crm-imports",
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      const body = crmImportBody.parse(request.body ?? {});
      await findLiveWorkbook(db, actor.workspaceId, id);
      await assertCrmFeature(db, actor.workspaceId);
      // The skipped-rows report is kept where imported files are.
      if (!importStorage(app.config)) throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, "Imports are not set up on this server.");
      return { status: 201, body: { data: await createCrmImport(db, crmAccess(db, app.config), actor, id, body) } };
    })
  );
}
