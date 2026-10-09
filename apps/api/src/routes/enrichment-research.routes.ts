import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { assertPermission, recordPrivilegedAction } from "@skout/auth";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import { addLinkedinUrl, attachPublicProfileUrl, type CaptureActor } from "../services/enrichment/capture-ingest.service.js";
import {
  CANDIDATE_PAGE_SIZE,
  CaptureError,
  PEOPLE_CSV_COLUMNS,
  deleteCompany,
  deletePerson,
  exportCompanyPeopleRows,
  getAccountEvidence,
  getCompany,
  getOverview,
  getPerson,
  getProspectEvidence,
  listCompanies,
  listCompanyPeople,
  listJobChanges,
  listPeople,
  reviewJobChange,
  toCsv,
} from "../services/enrichment/research.service.js";

const uuid = z.string().uuid();
const page = z.coerce.number().int().min(1).max(10_000).default(1);
const term = z.string().trim().max(120).optional();

const personFilterShape = {
  q: term,
  identity: z.enum(["public_profile", "sales_lead"]).optional(),
  department: term,
  seniority: term,
};
const peopleQuery = z.object({
  ...personFilterShape,
  state: z.enum(["verified", "candidate"]).optional(),
  companyId: uuid.optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const companyPeopleQuery = z.object({
  ...personFilterShape,
  group: z.enum(["verified", "candidates"]).default("candidates"),
  page,
  // Candidates are reviewed 15 at a time.
  pageSize: z.coerce.number().int().min(1).max(50).default(CANDIDATE_PAGE_SIZE),
});
const companiesQuery = z.object({ q: term, page, pageSize: z.coerce.number().int().min(1).max(100).default(25) });
const jobChangesQuery = z.object({
  status: z.enum(["pending", "reviewed", "all"]).default("all"),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const urlBody = z.object({ url: z.string().trim().url().max(2_000) }).strict();

type Permission = "enrichment:read" | "enrichment:capture" | "enrichment:export" | "enrichment:delete";

/**
 * ENR-03 — research read model over captured people and companies: lists and details,
 * verified employees vs. discovered candidates, the job-change feed, the ProspectEvidence /
 * AccountEvidence contract, and the audited attach / add / export / delete actions.
 */
export async function enrichmentResearchRoutes(app: FastifyInstance) {
  async function authorize(request: FastifyRequest, permission: Permission): Promise<{ db: Db; actor: CaptureActor }> {
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, permission);
    return { db: app.db, actor: { workspaceId, userId: request.userId } };
  }

  function sendCaptureError(reply: FastifyReply, error: unknown) {
    if (error instanceof CaptureError) {
      return reply.status(error.statusCode).send({ ok: false, error: error.message, code: error.code });
    }
    throw error;
  }

  const mutation = { config: { rateLimit: { max: 20, timeWindow: 60000 } } };
  const exporting = { config: { rateLimit: { max: 10, timeWindow: 60000 } } };

  app.get("/enrichment/overview", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    return reply.send({ workspaceId: actor.workspaceId, ...(await getOverview(db, actor.workspaceId)) });
  });

  // ── People ──────────────────────────────────────────────────────────────────

  app.get("/enrichment/people", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const filters = peopleQuery.parse(request.query ?? {});
    return reply.send({ workspaceId: actor.workspaceId, ...(await listPeople(db, actor.workspaceId, filters)) });
  });

  app.get("/enrichment/people/:id", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { id } = request.params as { id: string };
    const person = await getPerson(db, actor.workspaceId, id);
    if (!person) return reply.status(404).send({ error: "person_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, person });
  });

  app.delete("/enrichment/people/:id", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:delete");
    const { id } = request.params as { id: string };
    const result = await deletePerson(db, actor, id);
    if (!result) {
      return reply.status(404).send({ error: "prospect_not_found", message: "The requested person does not exist in your workspace" });
    }
    return reply.send({ success: true, workspaceId: actor.workspaceId, ...result });
  });

  // Attach a real public profile URL to a Sales Navigator lead.
  app.post("/enrichment/people/:id/public-url", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { id } = request.params as { id: string };
    const body = urlBody.parse(request.body ?? {});
    try {
      return reply.send({ workspaceId: actor.workspaceId, ...(await attachPublicProfileUrl(db, actor, id, body.url)) });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  // Register a LinkedIn profile or company URL for capture. Nothing is fetched from LinkedIn.
  app.post("/enrichment/linkedin-urls", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const body = urlBody.parse(request.body ?? {});
    try {
      return reply.status(201).send({ workspaceId: actor.workspaceId, ...(await addLinkedinUrl(db, actor, body.url)) });
    } catch (error) {
      return sendCaptureError(reply, error);
    }
  });

  // ── Companies ───────────────────────────────────────────────────────────────

  app.get("/enrichment/companies", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const filters = companiesQuery.parse(request.query ?? {});
    return reply.send({ workspaceId: actor.workspaceId, ...(await listCompanies(db, actor.workspaceId, filters)) });
  });

  app.get("/enrichment/companies/:id", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { id } = request.params as { id: string };
    const company = uuid.safeParse(id).success ? await getCompany(db, actor.workspaceId, id) : null;
    if (!company) return reply.status(404).send({ error: "company_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, company });
  });

  // Verified employees and discovered candidates are separate, paginated lists.
  app.get("/enrichment/companies/:id/people", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { id } = request.params as { id: string };
    const filters = companyPeopleQuery.parse(request.query ?? {});
    const result = uuid.safeParse(id).success ? await listCompanyPeople(db, actor.workspaceId, id, filters) : null;
    if (!result) return reply.status(404).send({ error: "company_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, companyId: id, ...result });
  });

  app.get("/enrichment/companies/:id/export.csv", exporting, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:export");
    const { id } = request.params as { id: string };
    const rows = uuid.safeParse(id).success ? await exportCompanyPeopleRows(db, actor.workspaceId, id) : null;
    if (!rows) return reply.status(404).send({ error: "company_not_found" });
    await recordPrivilegedAction(db, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "enrichment.export",
      entityType: "company",
      entityId: id,
      afterState: { exportedAt: new Date().toISOString(), recordCount: rows.length, scope: "company_people" },
    });
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="company-${id}-people.csv"`);
    return reply.send(toCsv(rows, ["group", ...PEOPLE_CSV_COLUMNS, "discoverySource"]));
  });

  app.delete("/enrichment/companies/:id", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:delete");
    const { id } = request.params as { id: string };
    const result = uuid.safeParse(id).success ? await deleteCompany(db, actor, id) : null;
    if (!result) {
      return reply.status(404).send({ error: "company_not_found", message: "The requested company does not exist in your workspace" });
    }
    return reply.send({ success: true, workspaceId: actor.workspaceId, ...result });
  });

  // ── Job changes ─────────────────────────────────────────────────────────────

  app.get("/enrichment/job-changes", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const filters = jobChangesQuery.parse(request.query ?? {});
    return reply.send({ workspaceId: actor.workspaceId, ...(await listJobChanges(db, actor.workspaceId, filters)) });
  });

  // Marks a job change as looked at. Review is the only thing a job change triggers.
  app.post("/enrichment/job-changes/:id/review", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:capture");
    const { id } = request.params as { id: string };
    const change = uuid.safeParse(id).success ? await reviewJobChange(db, actor, id) : null;
    if (!change) return reply.status(404).send({ error: "job_change_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, jobChange: change });
  });

  // ── ProspectEvidence / AccountEvidence ──────────────────────────────────────

  const prospectEvidence = async (request: FastifyRequest, reply: FastifyReply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { id } = request.params as { id: string };
    const evidence = await getProspectEvidence(db, actor.workspaceId, id);
    if (!evidence) return reply.status(404).send({ error: "person_not_found" });
    return reply.send(evidence);
  };
  const accountEvidence = async (request: FastifyRequest, reply: FastifyReply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { id } = request.params as { id: string };
    const evidence = uuid.safeParse(id).success ? await getAccountEvidence(db, actor.workspaceId, id) : null;
    if (!evidence) return reply.status(404).send({ error: "company_not_found" });
    return reply.send(evidence);
  };
  app.get("/enrichment/evidence/prospects/:id", prospectEvidence);
  app.get("/enrichment/evidence/accounts/:id", accountEvidence);
  // ENR-01 paths, now served by the same contract.
  app.get("/enrichment/people/:id/evidence", prospectEvidence);
  app.get("/enrichment/companies/:id/evidence", accountEvidence);
}
