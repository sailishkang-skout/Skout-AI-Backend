import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema } from "@skout/db";
import { COLUMN_WIDTH_MAX, COLUMN_WIDTH_MIN, MAX_COLUMNS, addColumn, deleteColumn, reorderColumns, updateColumn } from "../services/workbook-v2-columns.service.js";
import { WORKBOOK_NAME_MAX } from "../services/workbook-v2.service.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const columnParams = z.object({ id: uuid, columnId: uuid });

const name = z
  .string()
  .trim()
  .min(1)
  .max(WORKBOOK_NAME_MAX)
  // Postgres text cannot hold a NUL character; refuse it here rather than fail in the database.
  .refine((v) => !v.includes("\u0000"), "name must not contain a NUL character");
/** What a config may hold depends on the column's type and operation; the service checks it. */
const config = z.record(z.unknown());
const width = z.number().int().min(COLUMN_WIDTH_MIN).max(COLUMN_WIDTH_MAX);
const position = z.number().int().min(0).max(MAX_COLUMNS);

// `.strict()`: ids and timestamps are the server's to set.
const createBody = z
  .object({
    name,
    type: z.enum(schema.WORKBOOK_COLUMN_TYPES_V2),
    operation: z.string().min(1).max(50).nullable().optional(),
    config: config.optional(),
    position: position.optional(),
    width: width.optional(),
    hidden: z.boolean().optional(),
    frozen: z.boolean().optional(),
  })
  .strict();
// A column's type and operation do not change: its cells hold that operation's results. Delete it and add another.
const patchBody = z
  .object({ name: name.optional(), config: config.optional(), width: width.optional(), hidden: z.boolean().optional(), frozen: z.boolean().optional() })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), "send at least one property to change");
const columnList = z
  .array(uuid)
  .max(MAX_COLUMNS)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "a column is listed twice");
const reorderBody = z.object({ columnIds: columnList, previousColumnIds: columnList.optional() }).strict();

/**
 * Workbook columns (WB2-013), registered beside the workbook routes and behind the same `workbooks_v2` switch. Columns
 * are read with the workbook (GET /workbooks-v2/:id). Nothing here runs a column.
 */
export async function workbookV2ColumnRoutes(app: FastifyInstance) {
  const { authorize, handle, handleOnce } = workbookRouteHelpers(app);

  app.post(
    "/workbooks-v2/:id/columns",
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      return { status: 201, body: await addColumn(db, actor, id, createBody.parse(request.body ?? {})) };
    })
  );

  app.post(
    "/workbooks-v2/:id/columns/reorder",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await reorderColumns(db, actor, id, reorderBody.parse(request.body ?? {})) } };
    })
  );

  app.patch(
    "/workbooks-v2/:id/columns/:columnId",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, columnId } = columnParams.parse(request.params);
      return { status: 200, body: await updateColumn(db, actor, id, columnId, patchBody.parse(request.body ?? {})) };
    })
  );

  app.delete(
    "/workbooks-v2/:id/columns/:columnId",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, columnId } = columnParams.parse(request.params);
      const { columns, ...data } = await deleteColumn(db, actor, id, columnId);
      return { status: 200, body: { data, columns } };
    })
  );
}
