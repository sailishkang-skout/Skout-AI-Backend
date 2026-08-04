import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { commitImport, parseImportFile } from "../services/import-prospects.service.js";
import { errorResponse } from "../utils/http.js";

const parseSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  /** Base64-encoded file contents (no data: URL prefix). Max ~8MB decoded. */
  base64: z.string().min(1).max(12_000_000),
});

const commitSchema = z.object({
  rows: z
    .array(
      z.object({
        fullName: z.string().min(1),
        companyDomain: z.string().min(1),
        email: z.string().email().optional(),
        jobTitle: z.string().optional(),
        companyName: z.string().optional(),
        phone: z.string().optional(),
        linkedinUrl: z.string().optional(),
        country: z.string().optional(),
        city: z.string().optional(),
      })
    )
    .min(1)
    .max(500),
  listId: z.string().uuid().optional(),
  listName: z.string().min(1).max(255).optional(),
  autoEnrich: z.boolean().optional().default(false),
});

export async function importRoutes(app: FastifyInstance) {
  /**
   * Cheap auth check for the /admin/import static-auth page: confirms the
   * `admin_<secret>` bearer token is valid before the UI shows the upload form.
   * No side effects — just echoes back which workspace rows will land in.
   */
  app.get("/import/admin/ping", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    return reply.send({ data: { ok: true, workspaceId: request.workspaceId } });
  });

  /** Preview / parse an uploaded CSV, Excel, PDF, or image (OCR). */
  app.post("/import/prospects/parse", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const body = parseSchema.parse(request.body ?? {});
    const decodedBytes = Buffer.byteLength(body.base64, "base64");
    if (decodedBytes > 8 * 1024 * 1024) {
      return reply.code(413).send(errorResponse("File too large (max 8MB)", 413));
    }

    const result = await parseImportFile({
      filename: body.filename,
      mimeType: body.mimeType,
      base64: body.base64,
      openRouterApiKey: app.config.OPENROUTER_API_KEY,
    });

    return reply.send({
      data: {
        rows: result.rows.slice(0, 500),
        total: result.rows.length,
        source: result.source,
        warnings: result.warnings,
      },
    });
  });

  /** Commit parsed rows into the workspace (and optionally a list). */
  app.post("/import/prospects", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    if (!app.db) {
      return reply.code(503).send(errorResponse("Database unavailable", 503));
    }

    const body = commitSchema.parse(request.body ?? {});
    try {
      const result = await commitImport({
        db: app.db,
        config: app.config,
        workspaceId: request.workspaceId,
        rows: body.rows,
        listId: body.listId,
        listName: body.listName,
        autoEnrich: body.autoEnrich,
      });
      return reply.status(201).send({ data: result });
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.message === "list_not_found") {
        return reply.code(404).send(errorResponse("List not found", 404));
      }
      app.log.error({ err }, "Prospect import commit failed");
      return reply.code(e.statusCode ?? 500).send(errorResponse(e.message ?? "Import failed", e.statusCode ?? 500));
    }
  });
}
