import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { MAX_COLUMNS } from "../services/workbook-v2-columns.service.js";
import { WorkbookV2Error, WORKBOOK_NAME_MAX } from "../services/workbook-v2.service.js";
import { INPUT_DATA_TYPES } from "../services/workbook-cell-values.js";
import { MAX_IMPORT_HEADERS } from "../services/workbook-import-csv.js";
import { DEDUPE_KEYS } from "../services/workbook-import-plan.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { cancelImport, confirmImport, createImport, getImport, listImports, openImportReport } from "../services/workbook-imports.service.js";
import { workbookImportQueue } from "../workers/workbook-import.queue.js";
import { crmAccess } from "../services/workbook-crm-access.js";
import { assertSameCrmAccount } from "../services/workbook-crm.service.js";
import { assertCrmFeature } from "./workbook-v2-crm.routes.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const importParams = z.object({ id: uuid, importId: uuid });
// These take no parameters; one that looks meaningful (a workspaceId, say) is refused rather than ignored.
const noQuery = z.object({}).strict();
const header = z.number().int().min(0).max(MAX_IMPORT_HEADERS - 1);
const columnName = z
  .string()
  .trim()
  .min(1)
  .max(WORKBOOK_NAME_MAX)
  .refine((v) => !v.includes("\u0000"), "name must not contain a NUL character");
const mapping = z
  .object({ header, columnId: uuid.optional(), newColumn: z.object({ name: columnName, dataType: z.enum(INPUT_DATA_TYPES) }).strict().optional() })
  .strict()
  .refine((m) => (m.columnId === undefined) !== (m.newColumn === undefined), "send either columnId or newColumn");
const confirmBody = z
  .object({
    // Headers that are not listed are not imported.
    columns: z.array(mapping).max(MAX_COLUMNS),
    dedupe: z
      .object({ key: z.enum(DEDUPE_KEYS), header: header.optional() })
      .strict()
      .refine((d) => d.key !== "none" || d.header === undefined, "no column is needed without deduplication"),
  })
  .strict();

/** The name arrives percent-encoded in a header, which keeps it out of request URLs and so out of access logs. */
function fileNameOf(request: FastifyRequest): string | null {
  const raw = request.headers["x-file-name"];
  if (typeof raw !== "string") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * CSV import (WB2-020), registered beside the other Workbooks V2 routes and behind the same `workbooks_v2` switch.
 * Importing changes a workbook (`enrichment:capture`); following an import and reading its report is viewing.
 */
export async function workbookV2ImportRoutes(app: FastifyInstance) {
  const { authorize, handle } = workbookRouteHelpers(app);
  const storage = () => {
    const found = importStorage(app.config);
    if (!found) throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, "File imports are not set up on this server.");
    return found;
  };

  // The file is streamed, not parsed into memory, so this route takes the raw body whatever its type; the service
  // checks the type, size and content. Scoped to this child so every other route keeps its parsers.
  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

    raw.post(
      "/workbooks-v2/:id/imports",
      handle(async (request) => {
        const { db, actor } = await authorize(request, "enrichment:capture");
        const { id } = idParams.parse(request.params);
        noQuery.parse(request.query ?? {});
        const length = Number(request.headers["content-length"]);
        const data = await createImport(db, storage(), actor, id, {
          name: fileNameOf(request),
          contentType: request.headers["content-type"] ?? null,
          contentLength: Number.isFinite(length) ? length : null,
          body: request.body instanceof Readable ? request.body : null,
        });
        return { status: 201, body: { data } };
      })
    );
  });

  app.get(
    "/workbooks-v2/:id/imports",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id } = idParams.parse(request.params);
      noQuery.parse(request.query ?? {});
      return { status: 200, body: { data: await listImports(db, actor.workspaceId, id) } };
    })
  );

  app.get(
    "/workbooks-v2/:id/imports/:importId",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id, importId } = importParams.parse(request.params);
      return { status: 200, body: { data: await getImport(db, actor.workspaceId, id, importId) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/imports/:importId/confirm",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, importId } = importParams.parse(request.params);
      const choice = confirmBody.parse(request.body ?? {});
      const crm = crmAccess(db, app.config);
      const { background, data } = await confirmImport(db, { storage: storage(), queue: workbookImportQueue(app.config), crm }, actor, id, importId, choice, async (plan) => {
        await assertCrmFeature(db, actor.workspaceId);
        await assertSameCrmAccount(crm, actor.workspaceId, plan);
      });
      return { status: background ? 202 : 200, body: { data } };
    })
  );

  app.delete(
    "/workbooks-v2/:id/imports/:importId",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, importId } = importParams.parse(request.params);
      return { status: 200, body: { data: await cancelImport(db, storage(), actor.workspaceId, id, importId) } };
    })
  );

  app.get(
    "/workbooks-v2/:id/imports/:importId/report",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id, importId } = importParams.parse(request.params);
      const body = await openImportReport(db, storage(), actor.workspaceId, id, importId);
      return {
        status: 200,
        body,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="skipped-rows-${importId.slice(0, 8)}.csv"`,
          "cache-control": "private, no-store",
        },
      };
    })
  );
}
