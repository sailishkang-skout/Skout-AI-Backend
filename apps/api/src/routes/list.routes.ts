import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import type { OpenSearchConfig } from "@skout/opensearch";
import { searchFiltersSchema } from "@skout/shared";
import { buildEnrichmentService, InsufficientCreditsError } from "../services/enrichment/index.js";
import { createCrmService } from "../services/crm.service.js";
import { ListScoreService } from "../services/list-score.service.js";
import { HttpError, errorResponse } from "../utils/http.js";
import { buildListService } from "../services/list.service.js";
import { buildEmailVerificationService } from "../services/email-verification.service.js";
import { exportListCsv, CSV_EXPORT_CREDIT_COST } from "../services/list-export.service.js";
import { readListCsvExport } from "../services/export-storage.service.js";
import { buildSequenceService } from "../services/sequence.service.js";
import { createSmartList } from "../services/smart-list.service.js";
import { listSignalsForEntities, overlaySignalsForMember, type OverlaySignal } from "../services/signal.service.js";
import type { Env } from "../config/env.js";
import type { ProspectListMember } from "../services/enrichment/types.js";

async function withOverlaySignals(
  db: Db | null | undefined,
  members: ProspectListMember[]
): Promise<Array<ProspectListMember & { signals: OverlaySignal[] }>> {
  if (!db || members.length === 0) {
    return members.map((m) => ({ ...m, signals: [] }));
  }
  const ids = members.flatMap((m) => [m.prospectId, m.companyId]);
  const byEntity = await listSignalsForEntities(db, ids);
  return members.map((m) => ({
    ...m,
    signals: overlaySignalsForMember(byEntity, m.prospectId, m.companyId),
  }));
}

function osConfig(config: Env): OpenSearchConfig | null {
  if (!config.OPENSEARCH_URL) return null;
  return {
    url: config.OPENSEARCH_URL,
    username: config.OPENSEARCH_USERNAME,
    password: config.OPENSEARCH_PASSWORD,
    index: config.OPENSEARCH_INDEX,
  };
}

const enrichListSchema = z.object({
  fields: z.array(z.enum(["company", "email", "validation", "phone"])).optional(),
});

export async function listRoutes(app: FastifyInstance) {
  app.get("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    const data = await svc.getLists(workspaceId);
    return reply.send({ workspaceId, data, total: data.length });
  });

  // R10.1 — "New list" defaults to building a smart (filter-based) list; static-list creation
  // (used by CSV import / one-off manual adds) requires the explicit `mode: "static"` opt-in.
  const createListSchema = z.object({
    name: z.string().min(1).max(255),
    mode: z.enum(["smart", "static"]).default("smart"),
    filters: searchFiltersSchema.optional(),
  });

  app.post("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { name, mode, filters } = createListSchema.parse(request.body ?? {});

    if (mode === "smart") {
      const smartList = await createSmartList(app.db, workspaceId, name, filters ?? {});
      return reply.status(201).send({ ...smartList, kind: "smart" as const });
    }

    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const list = await svc.createList(workspaceId, name);
    return reply.status(201).send({ ...list, kind: "static" as const });
  });

  // R10.3 AC1 — one-click "convert to smart list" for a static list whose original filters were
  // recorded (currently: lists created by activating a smart list into a brand-new list).
  app.post("/lists/:id/convert-to-smart-list", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });

    const list = await svc.getListById(workspaceId, id);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    if (!list.sourceFilters) {
      return reply.status(422).send({
        error: "not_convertible",
        message: "This list's original filters aren't available, so it can't be converted to a smart list.",
      });
    }

    const smartList = await createSmartList(app.db, workspaceId, list.name, list.sourceFilters);
    return reply.status(201).send({ ...smartList, kind: "smart" as const });
  });

  app.get("/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const listSvc = buildListService(app.db, osConfig(app.config));
    if (!listSvc) return reply.status(503).send({ error: "database_unavailable" });
    const list = await listSvc.getListById(workspaceId, id);
    if (!list) return reply.status(404).send({ error: "list_not_found" });

    const members = await listSvc.getMembers(workspaceId, id);
    const enrichment = buildEnrichmentService(app.db, app.config);
    const scores = members?.length
      ? await enrichment.lookupScores(workspaceId, members.map((m) => m.prospectId))
      : {};

    const verifySvc = buildEmailVerificationService(app.db, app.config, osConfig(app.config));
    const verifications =
      verifySvc && members?.length
        ? await verifySvc.getForProspects(workspaceId, members.map((m) => m.prospectId))
        : {};

    const withSignals = await withOverlaySignals(app.db, members ?? []);

    return reply.send({
      ...list,
      members: withSignals.map((m) => ({
        ...m,
        score: scores[m.prospectId] ?? null,
        verification: verifications[m.prospectId] ?? null,
      })),
    });
  });

  app.get("/lists/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const members = await svc.getMembers(workspaceId, id);
    if (members === null) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(await withOverlaySignals(app.db, members));
  });

  app.post("/lists/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const memberSnapshotSchema = z.object({
      prospectId: z.string().min(1),
      fullName: z.string().optional(),
      title: z.string().optional(),
      seniority: z.string().optional(),
      industry: z.string().optional(),
      country: z.string().optional(),
      companyDomain: z.string().optional(),
      companyName: z.string().optional(),
      email: z.string().email().optional(),
      linkedinUrl: z.string().url().optional(),
      employeeCount: z.number().optional(),
      signals: z.array(z.string()).optional(),
    });
    const body = z
      .object({
        prospectIds: z.array(z.string().min(1)).min(1).optional(),
        prospects: z.array(memberSnapshotSchema).min(1).optional(),
      })
      .refine((value) => (value.prospectIds?.length ?? 0) > 0 || (value.prospects?.length ?? 0) > 0, {
        message: "prospectIds or prospects is required",
      })
      .parse(request.body ?? {});

    const members =
      body.prospects?.map((prospect) => ({
        prospectId: prospect.prospectId,
        snapshot: prospect,
      })) ??
      body.prospectIds!.map((prospectId) => ({ prospectId }));

    request.log.info(
      {
        workspaceId,
        listId: id,
        memberCount: members.length,
        prospectIds: members.map((m) => m.prospectId),
      },
      "lists/members add"
    );

    const svc = buildListService(app.db, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const list = await svc.addMembers(workspaceId, id, members);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.post("/lists/:id/enrich", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = enrichListSchema.parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const batch = await svc.enrichList(workspaceId, id, { fields: body.fields });
    return reply.status(202).send({ batchId: batch.id, status: batch.status, total: batch.total });
  });

  app.post("/lists/:id/score", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const svc = new ListScoreService(app.db, app.config);
    try {
      const result = await svc.start(workspaceId, id);
      if (result.status === "pending") {
        return reply.status(202).send({ jobId: result.jobId, status: result.status });
      }
      return reply.send(result);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: "insufficient_credits",
          required: err.required,
          available: err.available,
        });
      }
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  // POST /lists/:id/verify — bulk-verify every member's email before a send, store verdicts,
  // and return a deliverability summary (valid / risky / invalid / catch-all / unknown).
  app.post("/lists/:id/verify", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEmailVerificationService(app.db, app.config, osConfig(app.config));
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const summary = await svc.verifyList(workspaceId, id);
    if (!summary) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(summary);
  });

  app.patch("/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = z.object({ name: z.string().min(1).max(255) }).parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const list = await svc.renameList(workspaceId, id, body.name);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.delete("/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    await svc.deleteList(workspaceId, id);
    return reply.status(204).send();
  });

  app.delete("/lists/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const body = z.object({ prospectIds: z.array(z.string()).min(1) }).parse(request.body ?? {});
    const svc = buildEnrichmentService(app.db, app.config);
    const list = await svc.removeMembersFromList(workspaceId, id, body.prospectIds);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.delete("/lists/:id/members/:prospectId", async (request, reply) => {
    const { id, prospectId } = request.params as { id: string; prospectId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildEnrichmentService(app.db, app.config);
    const list = await svc.removeMembersFromList(workspaceId, id, [prospectId]);
    if (!list) return reply.status(404).send({ error: "list_not_found" });
    return reply.send(list);
  });

  app.get("/lists/:id/export/csv", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const listSvc = buildListService(app.db, osConfig(app.config));
    if (!listSvc) return reply.status(503).send({ error: "database_unavailable" });
    const enrichment = buildEnrichmentService(app.db, app.config);

    try {
      const result = await exportListCsv(app.config, listSvc, enrichment, workspaceId, id);
      if (result.inline && result.content) {
        return reply.send({
          downloadUrl: result.downloadUrl,
          filename: result.filename,
          creditsUsed: result.creditsUsed,
          memberCount: result.memberCount,
          expiresInSeconds: 900,
          exportKey: result.exportKey,
          ...(result.inline && result.content ? { content: result.content } : {}),
        });
      }
      return reply.send({
        downloadUrl: result.downloadUrl,
        filename: result.filename,
        creditsUsed: result.creditsUsed,
        memberCount: result.memberCount,
        expiresInSeconds: 900,
        exportKey: result.exportKey,
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: "insufficient_credits",
          required: err.required,
          available: err.available,
          creditsRequired: CSV_EXPORT_CREDIT_COST,
        });
      }
      if (err instanceof Error && err.message === "list_not_found") {
        return reply.status(404).send({ error: "list_not_found" });
      }
      throw err;
    }
  });

  app.get("/lists/:id/export/csv/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const { key } = z.object({ key: z.string().min(1) }).parse(request.query ?? {});

    if (!key.startsWith(`exports/${workspaceId}/${id}/`)) {
      return reply.status(403).send({ error: "invalid_export_key" });
    }

    const listSvc = buildListService(app.db, osConfig(app.config));
    if (!listSvc) return reply.status(503).send({ error: "database_unavailable" });
    const list = await listSvc.getListById(workspaceId, id);
    if (!list) return reply.status(404).send({ error: "list_not_found" });

    try {
      const content = await readListCsvExport(app.config, key);
      const filename = key.split("/").pop() ?? "export.csv";
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(content);
    } catch {
      return reply.status(404).send({ error: "export_not_found" });
    }
  });

  app.post("/lists/:id/export/hubspot", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const crm = createCrmService(app.db, app.config);
    try {
      const result = await crm.startHubSpotListExport(workspaceId, id);
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  // GET /lists/:id/sequences — sequences running on this list (has enrollments from this list)
  app.get("/lists/:id/sequences", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const seqSvc = buildSequenceService(app.db);
    if (!seqSvc) return reply.status(503).send({ error: "database_unavailable" });
    const data = await seqSvc.listSequencesForList(workspaceId, id);
    if (!data) return reply.status(404).send({ error: "not_found" });
    return reply.send({ workspaceId, data, total: data.length });
  });
}
