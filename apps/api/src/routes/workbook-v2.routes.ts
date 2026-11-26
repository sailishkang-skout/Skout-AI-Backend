import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  WORKBOOK_NAME_MAX,
  createWorkbook,
  deleteWorkbook,
  duplicateWorkbook,
  getWorkbook,
  listWorkbooks,
  renameWorkbook,
  restoreWorkbook,
} from "../services/workbook-v2.service.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

const name = z
  .string()
  .trim()
  .min(1)
  .max(WORKBOOK_NAME_MAX)
  // Postgres text cannot hold a NUL character; refuse it here rather than fail in the database.
  .refine((v) => !v.includes("\u0000"), "name must not contain a NUL character");
// `.strict()`: a client cannot send workspaceId, rowLimit, rowCount or any other server-owned field.
const createBody = z.object({ name }).strict();
const renameBody = z.object({ name }).strict();
const duplicateBody = z.object({ includeRows: z.boolean(), name: name.optional() }).strict();
const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Workbooks V2. Everything under /api/v1/workbooks-v2 belongs to the `workbooks_v2` feature switch
 * (WB2-002), off unless COPS has switched it on for the workspace: the access guard answers 403
 * feature_disabled before any handler here runs. CRUD is WB2-011; rows (WB2-012) and columns
 * (WB2-013) are registered beside it. The legacy /workbooks routes are separate and unchanged.
 */
export async function workbookV2Routes(app: FastifyInstance) {
  const { authorize, handle, handleOnce } = workbookRouteHelpers(app);

  app.get("/workbooks-v2/status", async (_request, reply) => reply.send({ data: { enabled: true } }));

  app.post(
    "/workbooks-v2",
    handleOnce(async (request, { db, actor }) => {
      const body = createBody.parse(request.body ?? {});
      return { status: 201, body: { data: await createWorkbook(db, actor, body) } };
    })
  );

  app.get(
    "/workbooks-v2",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const query = listQuery.parse(request.query ?? {});
      return { status: 200, body: await listWorkbooks(db, actor.workspaceId, query.page, query.pageSize) };
    })
  );

  app.get(
    "/workbooks-v2/:id",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await getWorkbook(db, actor.workspaceId, id) } };
    })
  );

  app.patch(
    "/workbooks-v2/:id",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      const body = renameBody.parse(request.body ?? {});
      return { status: 200, body: { data: await renameWorkbook(db, actor.workspaceId, id, body.name) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/duplicate",
    // A copy can be millions of cells; keep one caller from queueing many at once.
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      const body = duplicateBody.parse(request.body ?? {});
      return { status: 201, body: { data: await duplicateWorkbook(db, actor, id, body) } };
    })
  );

  app.delete(
    "/workbooks-v2/:id",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await deleteWorkbook(db, actor, id) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/restore",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await restoreWorkbook(db, actor, id) } };
    })
  );
}
