import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as XLSX from "xlsx";
import { commitImport, parseImportFile } from "../services/import-prospects.service.js";
import { errorResponse } from "../utils/http.js";

const parseSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  /** Base64-encoded file contents (no data: URL prefix). Max ~8MB decoded. */
  base64: z.string().min(1).max(12_000_000),
  /** Optional manual column mapping (source header -> target field) from a mapping-correction UI. */
  headerMap: z.record(z.string(), z.string()).optional(),
});

const SAMPLE_COLUMNS = [
  "fullName",
  "companyDomain",
  "email",
  "jobTitle",
  "companyName",
  "phone",
  "linkedinUrl",
  "country",
  "city",
] as const;

const SAMPLE_ROWS: Record<(typeof SAMPLE_COLUMNS)[number], string>[] = [
  {
    fullName: "Jane Doe",
    companyDomain: "acme.com",
    email: "jane.doe@acme.com",
    jobTitle: "VP Sales",
    companyName: "Acme Inc.",
    phone: "+1 415 555 0100",
    linkedinUrl: "https://www.linkedin.com/in/janedoe",
    country: "United States",
    city: "San Francisco",
  },
  {
    fullName: "Arjun Mehta",
    companyDomain: "globex.io",
    email: "arjun.mehta@globex.io",
    jobTitle: "Head of Growth",
    companyName: "Globex",
    phone: "+91 98765 43210",
    linkedinUrl: "https://www.linkedin.com/in/arjunmehta",
    country: "India",
    city: "Bengaluru",
  },
];

function buildSampleCsv(): string {
  const header = SAMPLE_COLUMNS.join(",");
  const rows = SAMPLE_ROWS.map((r) => SAMPLE_COLUMNS.map((c) => r[c]).join(","));
  return [header, ...rows].join("\n") + "\n";
}

const commitSchema = z.object({
  rows: z
    .array(
      z.object({
        fullName: z.string().min(1),
        companyDomain: z.string().min(1),
        // Not strictly RFC-validated here — messy source spreadsheets (e.g. bulk exports) often
        // have malformed emails (stray spaces, double dots). Rejecting the whole batch over one
        // bad row is worse than importing it with a slightly off email; real email-format
        // checking already happens later via the enrichment "validation" field.
        email: z.string().trim().max(320).optional(),
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
      headerMap: body.headerMap,
    });

    return reply.send({
      data: {
        rows: result.rows.slice(0, 500),
        total: result.rows.length,
        source: result.source,
        warnings: result.warnings,
        // Per-sheet/table header detection, so the UI can show exactly what was found and let
        // the user manually map columns when auto-detection misses something.
        sheets: result.sheets ?? [],
      },
    });
  });

  /**
   * Downloadable sample template matching the exact columns the importer recognizes, so users
   * don't have to guess header names. `format=csv` (default) or `format=xlsx`.
   */
  app.get("/import/sample", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const format = (request.query as { format?: string } | undefined)?.format === "xlsx" ? "xlsx" : "csv";

    if (format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", 'attachment; filename="skout-import-sample.csv"');
      return reply.send(buildSampleCsv());
    }

    const ws = XLSX.utils.json_to_sheet(SAMPLE_ROWS, { header: [...SAMPLE_COLUMNS] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Contacts");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    reply.header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    reply.header("Content-Disposition", 'attachment; filename="skout-import-sample.xlsx"');
    return reply.send(buf);
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
