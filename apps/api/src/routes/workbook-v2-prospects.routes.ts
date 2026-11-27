import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WorkbookV2Error } from "../services/workbook-v2.service.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { prospectDirectory } from "../services/prospect-directory.js";
import { MAX_CHOSEN, addProspectsToWorkbook, listProspects, smartListProspects } from "../services/workbook-prospects.service.js";
import { workbookImportQueue } from "../workers/workbook-import.queue.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

export const SOURCE_PAGE_DEFAULT = 25;
export const SOURCE_PAGE_MAX = 100;
/** 10,000 prospect ids, more than the global 1 MB body limit allows. */
const BODY_LIMIT = 3 * 1024 * 1024;

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const sourceParams = z.object({ id: uuid, sourceId: uuid });
const wholeNumber = z.string().regex(/^[1-9]\d{0,6}$/, "a whole number from 1").transform(Number);
const pageQuery = z.object({ page: wholeNumber.optional(), pageSize: wholeNumber.pipe(z.number().max(SOURCE_PAGE_MAX)).optional() }).strict();
const prospectId = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !v.includes("\u0000"), "must not contain a NUL character");
const addBody = z
  .object({
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("list"), listId: uuid }).strict(),
      z.object({ type: z.literal("smart_list"), smartListId: uuid }).strict(),
      z.object({ type: z.literal("search") }).strict(),
    ]),
    // Either the people picked, or everyone in the list or smart list.
    selection: z.union([z.object({ prospectIds: z.array(prospectId).min(1).max(MAX_CHOSEN) }).strict(), z.object({ all: z.literal(true) }).strict()]),
  })
  .strict();

/**
 * Rows from Skout lists, smart lists and Search (WB2-021), behind the same `workbooks_v2` switch. Browsing is viewing;
 * adding changes a workbook. Progress and reports are the import routes'.
 */
export async function workbookV2ProspectRoutes(app: FastifyInstance) {
  const { authorize, handle, handleOnce } = workbookRouteHelpers(app);

  /** One page of who a list or smart list holds, with whether each is already in the workbook. */
  const browsing = (browse: typeof listProspects) =>
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id, sourceId } = sourceParams.parse(request.params);
      const query = pageQuery.parse(request.query ?? {});
      const body = await browse(db, prospectDirectory(app.config), actor.workspaceId, id, sourceId, query.page ?? 1, query.pageSize ?? SOURCE_PAGE_DEFAULT);
      return { status: 200, body };
    });

  app.get("/workbooks-v2/:id/sources/lists/:sourceId/prospects", browsing(listProspects));
  app.get("/workbooks-v2/:id/sources/smart-lists/:sourceId/prospects", browsing(smartListProspects));

  app.post(
    "/workbooks-v2/:id/prospect-imports",
    { bodyLimit: BODY_LIMIT },
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      const body = addBody.parse(request.body ?? {});
      const storage = importStorage(app.config);
      if (!storage) throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, "Adding rows is not set up on this server.");
      const deps = { storage, queue: workbookImportQueue(app.config), directory: prospectDirectory(app.config) };
      const { background, data } = await addProspectsToWorkbook(db, deps, actor, id, body);
      return { status: background ? 202 : 200, body: { data } };
    })
  );
}
