/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-06 acceptance fixtures assert capture → CRM state.
 *   - Tables touched directly: contacts, companies (owned by apps/crm) — read, and contacts
 *     updated as a fixture
 *   - Owning service: apps/crm (test fixtures require direct access for setup and assertions)
 *   - Reason: the acceptance cases assert the CRM rows a capture produces, end to end.
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildTestAuth, buildTestAuthEnv, grantSystemMemberRole } from "@skout/auth";
import { loadEnv, type Env } from "../config/env.js";
import { buildApp } from "../app.js";
import { buildEntitlementsService } from "../services/entitlements.service.js";
import { ingestSalesSearchCapture } from "../services/enrichment/capture-ingest.service.js";
import { campaignSendGate, createCampaign, launchCampaign, reviewCampaign, submitCampaign, updateDraft } from "../services/enrichment/campaign.service.js";
import { defaultDraft } from "../services/enrichment/campaign-composer.js";
import { closeAbandonedCaptureRuns } from "../services/enrichment/ops.service.js";
import { JOB_ERRORS, recoverProviderJobs, runProviderJob } from "../services/enrichment/provider-jobs.service.js";
import { INTERNAL_ACCESS_ENTITLEMENT, releaseState } from "../services/enrichment/release-gate.js";

/**
 * ENR-06 — the handoff's manual end-to-end acceptance cases, as API-level tests. Each
 * `describe` is one case from the list; the UI side of each is in the frontend's
 * e2e/enrichment-acceptance.spec.ts. Together they are the release gate "ENR-01..05
 * acceptance complete".
 */

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const RUN = randomUUID().slice(0, 6);
let app: FastifyInstance;
let config: Env;
let owner: Record<string, string>;
let ownerId: string;
let outsider: Record<string, string>;

const { contacts, emailVerifications, enrichmentCaptureRuns, enrichmentJobs, sequenceEnrollments } = schema;

async function provisionUser(workspaceId: string) {
  const db = app.db!;
  const userId = randomUUID();
  const email = `acceptance-${userId}@example.com`;
  await db.insert(schema.users).values({ id: userId, email, fullName: "Acceptance Test User", status: "active" });
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId, role: "owner" });
  if (!(await grantSystemMemberRole(db, workspaceId, userId, "owner"))) throw new Error("System roles are not seeded");
  const auth = buildTestAuth({ workspaceId, userId, email, role: "owner" });
  return { userId, headers: { "x-workspace-id": workspaceId, "content-type": "application/json", Authorization: auth.bearer } };
}

beforeAll(async () => {
  config = {
    ...loadEnv(),
    LOG_LEVEL: "fatal" as const,
    ...buildTestAuthEnv(),
    CONSENT_ENFORCEMENT_ENABLED: false,
    LINKEDIN_ENRICHMENT_TEST_MODE: false,
    ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS: "@sandbox.example",
  };
  for (const key of ["EMAIL_INTEL_SERVICE_URL", "HUNTER_API_KEY", "MILLIONVERIFIER_API_KEY", "ZEROBOUNCE_API_KEY", "NEVERBOUNCE_API_KEY"] as const) {
    config = { ...config, [key]: undefined };
  }
  app = await buildApp(config);
  const db = app.db;
  if (!db) throw new Error("database_unavailable");
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.insert(schema.workspaces).values({ id, name: "Acceptance test", slug: `acceptance-${id}` });
  }
  const [ownerRole] = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.key, "owner"), isNull(schema.roles.workspaceId)))
    .limit(1);
  const permissions = await db.select({ key: schema.permissions.key }).from(schema.permissions).where(like(schema.permissions.key, "enrichment:%"));
  for (const key of [...permissions.map((permission) => permission.key), "sequences:send"]) {
    await db.insert(schema.rolePermissions).values({ roleId: ownerRole!.id, permissionKey: key }).onConflictDoNothing();
  }
  const o = await provisionUser(WORKSPACE);
  owner = o.headers;
  ownerId = o.userId;
  outsider = (await provisionUser(OTHER_WORKSPACE)).headers;
}, 60000);

afterAll(async () => {
  await app?.close();
});

const db = () => app.db!;
const actor = () => ({ workspaceId: WORKSPACE, userId: ownerId });
const post = (url: string, payload: unknown = {}, headers: Record<string, string> = owner) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as object });
const get = (url: string, headers = owner) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const del = (url: string, headers = owner) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });

const COMPANY = `acme-${RUN}`;
const COMPANY_NAME = `Acme ${RUN}`;
const SALES_URL = "https://www.linkedin.com/sales/search/people?query=(filters:List((type:CURRENT_COMPANY)))";
const leadUrl = (id: string) => `https://www.linkedin.com/sales/lead/${id},NAME_SEARCH,x`;
const lead = (id: string, fields: Record<string, unknown> = {}) => ({
  publicId: `sales-lead:${id}`,
  sourceUrl: leadUrl(id),
  fullName: `Lead ${id}`,
  headline: `Account Executive at ${COMPANY_NAME}`,
  currentCompanies: [{ name: COMPANY_NAME, title: "Account Executive" }],
  relationshipContext: { salesNavigatorLeadUrl: leadUrl(id) },
  ...fields,
});
const profile = (slug: string, fields: Record<string, unknown> = {}) => ({
  publicId: `${slug}-${RUN}`,
  sourceUrl: `https://www.linkedin.com/in/${slug}-${RUN}/`,
  fullName: `${slug} ${RUN}`,
  headline: `Head of Revenue at ${COMPANY_NAME}`,
  summary: "Runs revenue operations.",
  locationName: "Pune, India",
  currentCompanyPublicId: COMPANY,
  currentCompanies: [{ name: COMPANY_NAME, title: "Head of Revenue", companyPublicId: COMPANY }],
  previousCompanies: [{ name: "Hooli", title: "Sales Manager", dates: "2020 - 2024" }],
  educations: [{ school: "IIT Bombay", degree: "B.Tech" }],
  skills: [{ name: "Revenue Operations", endorsements: 8 }],
  ...fields,
});
const people = async (q: string) => (await get(`/enrichment/people?q=${encodeURIComponent(q)}&pageSize=100`)).json() as { total: number; people: Array<Record<string, any>> };
const companyId = async () => (await get(`/enrichment/companies?q=${encodeURIComponent(COMPANY_NAME)}`)).json().companies[0].id as string;

describe("Case 1 — capture and review a current public person profile", () => {
  it("stores what was reviewed, with evidence, and shows it back", async () => {
    await post("/enrichment/ingest/company", { publicId: COMPANY, sourceUrl: `https://www.linkedin.com/company/${COMPANY}/about/`, name: COMPANY_NAME, industry: "Software Development" });
    const res = await post("/enrichment/ingest/person", profile("priya"));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ received: 1, created: 1, rejected: 0 });
    // The capture is its own run and is already terminal when the response arrives.
    expect(res.json().run).toMatchObject({ kind: "person", status: "completed" });

    const person = (await get(`/enrichment/people/${res.json().person.prospectId}`)).json().person;
    expect(person).toMatchObject({ fullName: `priya ${RUN}`, identity: "public_profile", employmentState: "verified", companyName: COMPANY_NAME, pendingCapture: false });
    expect(person.experience.current[0]).toMatchObject({ title: "Head of Revenue" });
    expect(person.experience.previous[0]).toMatchObject({ name: "Hooli" });
    expect(person.educations[0]).toMatchObject({ school: "IIT Bombay" });
    const employment = person.facts.find((fact: any) => fact.attribute === "employment");
    expect(employment).toMatchObject({ state: "verified", source: "linkedin_public_profile", usableForClaims: true });
    expect(employment.sourceUrl).toBe(`https://www.linkedin.com/in/priya-${RUN}/`);
  });
});

describe("Case 2 — a company with About and People tabs", () => {
  it("keeps company facts from About and treats People results as candidates, not employees", async () => {
    const about = await post("/enrichment/ingest/company", {
      publicId: COMPANY,
      sourceUrl: `https://www.linkedin.com/company/${COMPANY}/about/`,
      name: COMPANY_NAME,
      website: `https://www.acme-${RUN}.example`,
      industry: "Software Development",
      size: "201-500 employees",
      headquarter: "Austin, Texas",
      overview: "Acme builds software.",
      employeesOnLi: 412,
    });
    expect(about.statusCode, about.body).toBe(201);
    const peopleTab = await post("/enrichment/ingest/company", {
      publicId: COMPANY,
      sourceUrl: `https://www.linkedin.com/company/${COMPANY}/people/`,
      name: COMPANY_NAME,
      pagesRead: 2,
      peopleProfiles: Array.from({ length: 6 }, (_, index) => ({
        publicId: `tab-${index}-${RUN}`,
        sourceUrl: `https://www.linkedin.com/in/tab-${index}-${RUN}/`,
        fullName: `Tab Person ${index} ${RUN}`,
        headline: "Engineer",
        associationSource: "company-search-result",
      })),
    });
    expect(peopleTab.statusCode, peopleTab.body).toBe(201);
    expect(peopleTab.json().run).toMatchObject({ kind: "company", status: "completed", pagesRead: 2, leadsReceived: 6 });

    const id = await companyId();
    const company = (await get(`/enrichment/companies/${id}`)).json().company;
    // The People capture did not wipe what the About capture stored.
    expect(company).toMatchObject({ name: COMPANY_NAME, industry: "Software Development" });
    expect(company.capture).toMatchObject({ size: "201-500 employees", headquarter: "Austin, Texas" });
    expect(company.people).toMatchObject({ visibleAssociatedMembers: 412, verifiedEmployees: 1, discoveryCandidates: 6 });

    const candidates = (await get(`/enrichment/companies/${id}/people?group=candidates`)).json();
    expect(candidates.total).toBe(6);
    expect(candidates.people.every((person: any) => person.employmentState === "candidate")).toBe(true);
    const verified = (await get(`/enrichment/companies/${id}/people?group=verified`)).json();
    expect(verified.people.map((person: any) => person.fullName)).toEqual([`priya ${RUN}`]);
  });
});

describe("Case 3 — an eight-page Sales Navigator search", () => {
  const ids = (page: number) => Array.from({ length: page === 8 ? 22 : 23 }, (_, index) => `ACwAA${RUN}p${page}n${index}`);

  it("captures 183 distinct leads across eight pages in one run, and a lead without a public link stays a Sales lead", async () => {
    const started = await post("/enrichment/capture/runs", { kind: "sales_search", sourceUrl: SALES_URL, clientRunId: `eight-pages-${RUN}` });
    expect(started.statusCode, started.body).toBe(201);
    const runId = started.json().run.id as string;
    expect(started.json().run.status).toBe("running");

    for (let page = 1; page <= 8; page++) {
      // One lead on page 3 shows its public profile link; none of the others does.
      const profiles = ids(page).map((id, index) =>
        page === 3 && index === 0
          ? { publicId: `visible-${RUN}`, sourceUrl: `https://www.linkedin.com/in/visible-${RUN}/`, fullName: `Lead ${id}`, relationshipContext: { salesNavigatorLeadUrl: leadUrl(id) } }
          : lead(id)
      );
      const outcome = await ingestSalesSearchCapture(db(), actor(), { runId, sourceUrl: SALES_URL, pagesRead: 1, peopleProfiles: profiles as any });
      expect(outcome.run.status).toBe("running");
    }
    const finished = await post(`/enrichment/capture/runs/${runId}/finish`, { status: "completed" });
    expect(finished.json().run).toMatchObject({ status: "completed", pagesRead: 8, leadsReceived: 183, leadsCreated: 183, leadsMerged: 0, leadsRejected: 0 });

    const sales = (await get(`/enrichment/people?q=${encodeURIComponent(`ACwAA${RUN}`)}&identity=sales_lead&pageSize=1`)).json();
    expect(sales.total).toBe(182);
    const stayed = (await people(`Lead ACwAA${RUN}p1n0`)).people[0]!;
    expect(stayed).toMatchObject({ identity: "sales_lead", linkedinUrl: null, employmentState: "candidate" });
    expect(stayed.salesNavigatorLeadUrl).toBe(leadUrl(`ACwAA${RUN}p1n0`));
    // No public URL was derived from the opaque lead id.
    const [contact] = await db().select().from(contacts).where(and(eq(contacts.workspaceId, WORKSPACE), eq(contacts.sourceProspectId, stayed.prospectId)));
    expect(contact!.linkedinUrl ?? "").not.toMatch(/linkedin\.com\/in\//);
    expect((await people(`Lead ACwAA${RUN}p3n0`)).people[0]).toMatchObject({ identity: "public_profile", linkedinUrl: `https://www.linkedin.com/in/visible-${RUN}/` });
  });

  it("stops at the ten-page and 250-lead caps before writing anything", async () => {
    const started = await post("/enrichment/capture/runs", { kind: "sales_search", sourceUrl: SALES_URL });
    const runId = started.json().run.id as string;
    const before = (await people(`Cap ${RUN}`)).total;
    await expect(
      ingestSalesSearchCapture(db(), actor(), { runId, sourceUrl: SALES_URL, pagesRead: 10, peopleProfiles: [lead(`cap${RUN}a`, { fullName: `Cap ${RUN} A` })] as any })
    ).resolves.toBeTruthy();
    await expect(
      ingestSalesSearchCapture(db(), actor(), { runId, sourceUrl: SALES_URL, pagesRead: 1, peopleProfiles: [lead(`cap${RUN}b`, { fullName: `Cap ${RUN} B` })] as any })
    ).rejects.toMatchObject({ code: "page_cap_exceeded" });
    await expect(
      ingestSalesSearchCapture(db(), actor(), {
        runId,
        sourceUrl: SALES_URL,
        pagesRead: 1,
        peopleProfiles: Array.from({ length: 250 }, (_, index) => lead(`cap${RUN}over${index}`, { fullName: `Cap ${RUN} over ${index}` })) as any,
      })
    ).rejects.toMatchObject({ statusCode: 422 });
    // The refused requests wrote nothing; the run keeps what it had and can still be finished.
    expect((await people(`Cap ${RUN}`)).total).toBe(before + 1);
    const run = (await get(`/enrichment/capture/runs/${runId}`)).json().run;
    expect(run).toMatchObject({ status: "running", pagesRead: 10, leadsReceived: 1 });
    expect((await post(`/enrichment/capture/runs/${runId}/finish`, { status: "completed" })).json().run.status).toBe("completed");
  });

  it("records a partly unreadable page: usable cards are saved, the rest are counted as rejected", async () => {
    const res = await post("/enrichment/ingest/sales-search", {
      sourceUrl: SALES_URL,
      pagesRead: 1,
      peopleProfiles: [lead(`part${RUN}a`, { fullName: `Partial ${RUN} A` }), lead(`part${RUN}b`, { fullName: "LinkedIn Member" }), lead(`part${RUN}c`, { fullName: `Partial ${RUN} C` })],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ received: 3, created: 2, rejected: 1 });
    expect(res.json().run).toMatchObject({ status: "completed", leadsReceived: 3, leadsRejected: 1 });
    expect((await people(`Partial ${RUN}`)).total).toBe(2);
  });

  it("marks a run the user stopped part-way as stopped, keeping what was captured", async () => {
    const started = await post("/enrichment/capture/runs", { kind: "sales_search", sourceUrl: SALES_URL });
    const runId = started.json().run.id as string;
    await ingestSalesSearchCapture(db(), actor(), { runId, sourceUrl: SALES_URL, pagesRead: 1, peopleProfiles: [lead(`stop${RUN}`, { fullName: `Stopped ${RUN}` })] as any });
    const stopped = await post(`/enrichment/capture/runs/${runId}/finish`, { status: "stopped", reason: "Stopped by the user after page 1" });
    expect(stopped.json().run).toMatchObject({ status: "stopped", pagesRead: 1, leadsReceived: 1 });
    expect((await people(`Stopped ${RUN}`)).total).toBe(1);
  });
});

describe("Case 4 — repeating a department search", () => {
  it("adds no duplicate people", async () => {
    const batch = Array.from({ length: 12 }, (_, index) => lead(`dept${RUN}n${index}`, { fullName: `Dept ${RUN} ${index}` }));
    const first = await post("/enrichment/ingest/sales-search", { sourceUrl: SALES_URL, filters: ["Function: Sales"], pagesRead: 1, peopleProfiles: batch });
    expect(first.json()).toMatchObject({ received: 12, created: 12, merged: 0 });
    const again = await post("/enrichment/ingest/sales-search", { sourceUrl: SALES_URL, filters: ["Function: Sales"], pagesRead: 1, peopleProfiles: batch });
    expect(again.json()).toMatchObject({ received: 12, created: 0, merged: 12 });
    // A second department that overlaps the first adds only the new people.
    const overlap = [...batch.slice(0, 4), lead(`dept${RUN}new`, { fullName: `Dept ${RUN} new` })];
    const other = await post("/enrichment/ingest/sales-search", { sourceUrl: SALES_URL, filters: ["Function: Marketing"], pagesRead: 1, peopleProfiles: overlap });
    expect(other.json()).toMatchObject({ received: 5, created: 1, merged: 4 });

    expect((await people(`Dept ${RUN}`)).total).toBe(13);
    const rows = await db().select({ id: contacts.id }).from(contacts).where(and(eq(contacts.workspaceId, WORKSPACE), like(contacts.firstName, "Dept%"), isNull(contacts.deletedAt)));
    expect(rows).toHaveLength(13);
  });
});

describe("Case 5 — attach a public URL to a lead; candidate vs verified employee", () => {
  it("merges on the attached URL without verifying the employer, and verifies only on a profile capture", async () => {
    await post("/enrichment/ingest/sales-search", { sourceUrl: SALES_URL, pagesRead: 1, peopleProfiles: [lead(`att${RUN}`, { fullName: `Attach ${RUN}` })] });
    const before = (await people(`Attach ${RUN}`)).people[0]!;
    expect(before).toMatchObject({ identity: "sales_lead", employmentState: "candidate" });

    const attached = await post(`/enrichment/people/${before.prospectId}/public-url`, { url: `https://www.linkedin.com/in/attach-${RUN}/` });
    expect(attached.statusCode, attached.body).toBe(200);
    const after = (await get(`/enrichment/people/${attached.json().prospectId}`)).json().person;
    expect(after).toMatchObject({ identity: "public_profile", linkedinUrl: `https://www.linkedin.com/in/attach-${RUN}/`, employmentState: "candidate" });
    expect(after.identityKeys).toEqual(expect.arrayContaining([`in:attach-${RUN}`, `sales-lead:att${RUN}`]));

    const id = await companyId();
    const inCandidates = async () => (await get(`/enrichment/companies/${id}/people?group=candidates&q=${encodeURIComponent(`Attach ${RUN}`)}`)).json().total;
    const inVerified = async () => (await get(`/enrichment/companies/${id}/people?group=verified&q=${encodeURIComponent(`Attach ${RUN}`)}`)).json().total;
    expect([await inCandidates(), await inVerified()]).toEqual([1, 0]);

    // Their own profile is captured: now, and only now, the employer is verified.
    await post("/enrichment/ingest/person", profile("attach", { fullName: `Attach ${RUN}` }));
    expect([await inCandidates(), await inVerified()]).toEqual([0, 1]);
    expect((await people(`Attach ${RUN}`)).total).toBe(1);

    expect((await post(`/enrichment/people/${before.prospectId}/public-url`, { url: "https://www.linkedin.com/sales/lead/x,NAME,x" })).statusCode).toBe(400);
  });
});

describe("Case 6 — CSV export, delete and re-enrich", () => {
  it("exports the person, re-enriches through a job that reaches a terminal state, and deletes with the evidence", async () => {
    const res = await post("/enrichment/ingest/person", profile("csv", { fullName: `Csv ${RUN}` }));
    const prospectId = res.json().person.prospectId as string;

    const csv = await get(`/enrichment/people/${prospectId}/export.csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const [header, line] = csv.body.trim().split("\n");
    expect(header).toContain("fullName");
    expect(line).toContain(`Csv ${RUN}`);
    const companyCsv = await get(`/enrichment/companies/${await companyId()}/export.csv`);
    expect(companyCsv.statusCode).toBe(200);
    expect(companyCsv.body.split("\n")[0]).toContain("group");

    const created = await post("/enrichment/provider-jobs", { url: `https://www.linkedin.com/in/csv-${RUN}/` });
    expect(created.statusCode, created.body).toBe(202);
    const jobId = created.json().job.id as string;
    expect(created.json().job).toMatchObject({ status: "queued", terminal: false, targetId: prospectId });
    await runProviderJob(db(), config, jobId);
    const job = (await get(`/enrichment/provider-jobs/${jobId}`)).json().job;
    // No provider is approved yet, so the run stops with a reason instead of pretending to succeed.
    expect(job).toMatchObject({ status: "action_required", terminal: true, errorCode: JOB_ERRORS.PROVIDER_NOT_PERMITTED });
    expect(job.errorMessage).toBeTruthy();

    const removed = await del(`/enrichment/people/${prospectId}`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().evidenceRemoved).toBeGreaterThan(0);
    expect((await get(`/enrichment/people/${prospectId}`)).statusCode).toBe(404);
    expect(await db().select().from(enrichmentJobs).where(eq(enrichmentJobs.id, jobId))).toEqual([]);
    expect((await people(`Csv ${RUN}`)).total).toBe(0);
  });
});

describe("Case 7 — restart the backend and the extension during a queued job", () => {
  it("recovers a job after a backend restart, or fails it where the user can see", async () => {
    const queued = (await post("/enrichment/provider-jobs", { url: `https://www.linkedin.com/in/restart-a-${RUN}/` })).json().job;
    // The process dies after claiming the job: the row says running, nobody is running it.
    await db().update(enrichmentJobs).set({ status: "running", attemptCount: 1, leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(enrichmentJobs.id, queued.id));
    const recovery = await recoverProviderJobs(db());
    expect(recovery.due).toContain(queued.id);
    expect((await get(`/enrichment/provider-jobs/${queued.id}`)).json().job).toMatchObject({ status: "queued", errorCode: JOB_ERRORS.WORKER_INTERRUPTED });
    await runProviderJob(db(), config, queued.id);
    expect((await get(`/enrichment/provider-jobs/${queued.id}`)).json().job).toMatchObject({ terminal: true, attemptCount: 2 });

    const last = (await post("/enrichment/provider-jobs", { url: `https://www.linkedin.com/in/restart-b-${RUN}/` })).json().job;
    await db().update(enrichmentJobs).set({ status: "running", attemptCount: 3, leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(enrichmentJobs.id, last.id));
    await recoverProviderJobs(db());
    const failed = (await get(`/enrichment/provider-jobs/${last.id}`)).json().job;
    expect(failed).toMatchObject({ status: "failed", terminal: true, errorCode: JOB_ERRORS.WORKER_LOST });
    expect(failed.errorMessage).toMatch(/worker stopped/i);
  });

  it("closes a capture the extension never finished as failed, with the reason", async () => {
    const started = await post("/enrichment/capture/runs", { kind: "sales_search", sourceUrl: SALES_URL, clientRunId: `reloaded-${RUN}` });
    const runId = started.json().run.id as string;
    // A retried start (the extension reloaded and tried again) returns the same run.
    const again = await post("/enrichment/capture/runs", { kind: "sales_search", sourceUrl: SALES_URL, clientRunId: `reloaded-${RUN}` });
    expect(again.json().run.id).toBe(runId);

    await db().update(enrichmentCaptureRuns).set({ updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(enrichmentCaptureRuns.id, runId));
    expect(await closeAbandonedCaptureRuns(db())).toBeGreaterThanOrEqual(1);
    const run = (await get(`/enrichment/capture/runs/${runId}`)).json().run;
    expect(run).toMatchObject({ status: "failed", errorCode: "abandoned" });
    expect(run.errorMessage).toMatch(/not finished/i);
    // A closed run takes no more leads.
    await expect(ingestSalesSearchCapture(db(), actor(), { runId, sourceUrl: SALES_URL, pagesRead: 1, peopleProfiles: [lead(`late${RUN}`)] as any })).rejects.toMatchObject({ code: "run_not_active" });
  });
});

describe("Case 8 — a campaign with sandbox recipients only", () => {
  it("sends nothing to a real address outside production, and nothing at all without approval", async () => {
    const make = async (slug: string, email: string) => {
      const prospectId = (await post("/enrichment/ingest/person", profile(slug, { fullName: `${slug} ${RUN}` }))).json().person.prospectId as string;
      await db().update(contacts).set({ email }).where(and(eq(contacts.workspaceId, WORKSPACE), eq(contacts.sourceProspectId, prospectId)));
      await db().insert(emailVerifications).values({ workspaceId: WORKSPACE, prospectId, email, status: "valid", deliverabilityScore: 97, provider: "zerobounce" });
      return prospectId;
    };
    const sandbox = await make("sandy", `sandy-${RUN}@sandbox.example`);
    const real = await make("rhea", `rhea-${RUN}@real-customer.example`);

    const campaign = await createCampaign(db(), config, actor(), { name: `Sandbox ${RUN}`, prospectIds: [sandbox, real] });
    await expect(launchCampaign(db(), config, actor(), campaign.id)).rejects.toMatchObject({ code: "approval_required" });
    expect(await db().select().from(sequenceEnrollments).where(and(eq(sequenceEnrollments.workspaceId, WORKSPACE), eq(sequenceEnrollments.prospectId, sandbox)))).toEqual([]);

    await updateDraft(db(), actor(), campaign.id, defaultDraft(false).steps.map((step) => ({ ...step, body: step.body.replace(/\[Write[^\]]*\]/, "We help revenue teams.") })));
    await submitCampaign(db(), config, actor(), campaign.id);
    await reviewCampaign(db(), config, actor(), campaign.id, { decision: "approved", comment: "Sandbox exercise" });
    const { newEnrollments } = await launchCampaign(db(), config, actor(), campaign.id);
    const enrollment = Object.fromEntries(newEnrollments.map((entry) => [entry.prospectId, entry.enrollmentId]));

    expect(await campaignSendGate(db(), config, WORKSPACE, enrollment[sandbox]!, `sandy-${RUN}@sandbox.example`)).toEqual({ allowed: true });
    expect(await campaignSendGate(db(), config, WORKSPACE, enrollment[real]!, `rhea-${RUN}@real-customer.example`)).toEqual({ allowed: false, reason: "sandbox_recipient_blocked", retry: false });
  });
});

describe("Release gates", () => {
  it("keeps every enrichment record inside its workspace", async () => {
    const person = (await people(`priya ${RUN}`)).people[0]!;
    const id = await companyId();
    const job = (await post("/enrichment/provider-jobs", { url: `https://www.linkedin.com/in/isolation-${RUN}/` })).json().job;
    const campaign = await createCampaign(db(), config, actor(), { name: `Isolation ${RUN}`, prospectIds: [person.prospectId] });
    const run = (await get("/enrichment/capture/runs")).json().runs[0];

    const single: Array<[string, string]> = [
      ["GET", `/enrichment/people/${person.prospectId}`],
      ["GET", `/enrichment/people/${person.prospectId}/evidence`],
      ["GET", `/enrichment/people/${person.prospectId}/contact-data`],
      ["GET", `/enrichment/people/${person.prospectId}/export.csv`],
      ["DELETE", `/enrichment/people/${person.prospectId}`],
      ["GET", `/enrichment/companies/${id}`],
      ["GET", `/enrichment/companies/${id}/people`],
      ["GET", `/enrichment/companies/${id}/export.csv`],
      ["DELETE", `/enrichment/companies/${id}`],
      ["GET", `/enrichment/evidence/accounts/${id}`],
      ["GET", `/enrichment/capture/runs/${run.id}`],
      ["GET", `/enrichment/provider-jobs/${job.id}`],
      ["GET", `/enrichment/campaigns/${campaign.id}`],
      ["POST", `/enrichment/campaigns/${campaign.id}/launch`],
      ["POST", `/enrichment/campaigns/${campaign.id}/submit`],
    ];
    for (const [method, url] of single) {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: outsider, ...(method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const lists: Array<[string, string]> = [
      ["/enrichment/people", "people"],
      ["/enrichment/companies", "companies"],
      ["/enrichment/job-changes", "jobChanges"],
      ["/enrichment/capture/runs", "runs"],
      ["/enrichment/provider-jobs", "data"],
      ["/enrichment/campaigns", "campaigns"],
      ["/enrichment/audiences", "audiences"],
    ];
    for (const [url, key] of lists) {
      const res = await get(url, outsider);
      expect(res.statusCode, url).toBe(200);
      expect(res.json()[key], url).toEqual([]);
    }
    expect((await get("/enrichment/ops", outsider)).json().snapshot.jobs.byStatus.queued).toBe(0);
    // Still there for its own workspace.
    expect((await get(`/enrichment/people/${person.prospectId}`)).statusCode).toBe(200);
    // And nothing is served without a session.
    expect((await app.inject({ method: "GET", url: "/api/v1/enrichment/people", headers: { "x-workspace-id": WORKSPACE } })).statusCode).toBe(401);
  });

  it("stays internal in production until a workspace is given access", async () => {
    const production = await buildApp({ ...config, NODE_ENV: "production", ENRICHMENT_RELEASE_STAGE: "internal" });
    try {
      const call = (url: string, method: "GET" | "POST" = "GET") => production.inject({ method, url: `/api/v1${url}`, headers: owner, ...(method === "POST" ? { payload: {} } : {}) });
      for (const [url, method] of [
        ["/enrichment/people", "GET"],
        ["/enrichment/capture/status", "GET"],
        ["/enrichment/provider-jobs", "GET"],
        ["/enrichment/campaigns", "GET"],
        ["/enrichment/ingest/person", "POST"],
        ["/enrichment/export", "POST"],
      ] as const) {
        const res = await call(url, method);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().code).toBe("enrichment_not_released");
      }
      expect((await call("/enrichment/release")).json()).toMatchObject({ enabled: false, stage: "internal" });
      // The older enrichment features are not part of this release and keep working.
      expect((await call("/enrichment/credits")).statusCode).toBe(200);

      await buildEntitlementsService(db())!.set(WORKSPACE, INTERNAL_ACCESS_ENTITLEMENT, true);
      expect((await call("/enrichment/people")).statusCode).toBe(200);
      expect((await call("/enrichment/release")).json()).toMatchObject({ enabled: true, stage: "internal", reason: null });
      // Another workspace is still out.
      expect((await production.inject({ method: "GET", url: "/api/v1/enrichment/people", headers: outsider })).statusCode).toBe(403);
    } finally {
      await production.close();
    }
  });

  it("opens to every workspace only with a recorded approval", () => {
    const base = { NODE_ENV: "production" as const, ENRICHMENT_LEGAL_APPROVAL_REF: undefined };
    expect(releaseState({ ...base, ENRICHMENT_RELEASE_STAGE: "general" })).toMatchObject({ stage: "internal", legalApprovalRecorded: false, enforced: true });
    expect(releaseState({ ...base, ENRICHMENT_RELEASE_STAGE: "general", ENRICHMENT_LEGAL_APPROVAL_REF: "  " })).toMatchObject({ stage: "internal" });
    expect(releaseState({ ...base, ENRICHMENT_RELEASE_STAGE: "general", ENRICHMENT_LEGAL_APPROVAL_REF: "LEGAL-142" })).toMatchObject({ stage: "general", legalApprovalRecorded: true });
    expect(releaseState({ ...base, NODE_ENV: "development", ENRICHMENT_RELEASE_STAGE: "internal" })).toMatchObject({ stage: "internal", enforced: false });
  });
});
