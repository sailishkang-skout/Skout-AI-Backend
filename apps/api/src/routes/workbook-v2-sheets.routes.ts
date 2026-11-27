import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WorkbookV2Error, findLiveWorkbook } from "../services/workbook-v2.service.js";
import { createSheetImport, forgetSheetSource, inspectSpreadsheet, listSheetSources, pullSheetSource } from "../services/workbook-sheets.service.js";
import { sheetsReader } from "../services/workbook-sheets-access.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { workbookImportQueue } from "../workers/workbook-import.queue.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const sourceParams = z.object({ id: uuid, sourceId: uuid });
/** The link is checked by the service; only Google Sheets links and ids are read. */
const spreadsheet = z.string().min(1).max(2_000);
const inspectBody = z.object({ spreadsheet }).strict();
const importBody = z.object({ spreadsheet, sheetId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const noBody = z.object({}).strict();

/**
 * Google Sheets as a row source (WB2-025), registered beside the other Workbooks V2 routes and behind the same
 * `workbooks_v2` switch. Reading a sheet into a workbook needs edit permission (`enrichment:capture`); seeing which tabs
 * a workbook pulls from is viewing. Google is always read through the session member's own connection: no request names
 * one. A created import is confirmed, followed and reported through the import routes (WB2-020).
 */
export async function workbookV2SheetsRoutes(app: FastifyInstance) {
  const { authorize, handle, handleOnce } = workbookRouteHelpers(app);
  const storage = () => {
    const found = importStorage(app.config);
    if (!found) throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, "Imports are not set up on this server.");
    return found;
  };

  app.get(
    "/workbooks-v2/:id/sheet-sources",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await listSheetSources(db, actor.workspaceId, id) } };
    })
  );

  // A POST, so that a spreadsheet's link stays out of request addresses and so out of access logs.
  app.post(
    "/workbooks-v2/:id/sheets/inspect",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      const body = inspectBody.parse(request.body ?? {});
      return { status: 200, body: { data: await inspectSpreadsheet(db, sheetsReader(db, app.config), actor, id, body.spreadsheet) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/sheets-imports",
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      const body = importBody.parse(request.body ?? {});
      await findLiveWorkbook(db, actor.workspaceId, id);
      return { status: 201, body: { data: await createSheetImport(db, storage(), sheetsReader(db, app.config), actor, id, body) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/sheet-sources/:sourceId/pull",
    handleOnce(async (request, { db, actor }) => {
      const { id, sourceId } = sourceParams.parse(request.params);
      noBody.parse(request.body ?? {});
      const deps = { storage: storage(), queue: workbookImportQueue(app.config), sheets: sheetsReader(db, app.config) };
      const { background, alreadyRunning, data } = await pullSheetSource(db, deps, actor, id, sourceId);
      return { status: background ? 202 : 200, body: { data, alreadyRunning } };
    })
  );

  app.delete(
    "/workbooks-v2/:id/sheet-sources/:sourceId",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, sourceId } = sourceParams.parse(request.params);
      await forgetSheetSource(db, actor, id, sourceId);
      return { status: 200, body: { data: { id: sourceId } } };
    })
  );
}
