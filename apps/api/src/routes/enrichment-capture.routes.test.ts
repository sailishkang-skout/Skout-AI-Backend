/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-02 test fixtures assert capture → CRM state.
 *   - Tables touched directly: contacts, companies (both owned by apps/crm)
 *     - read only
 *   - Owning service: apps/crm (test fixtures require direct access for assertions)
 *   - Reason: integration tests validate that a capture resolves to one CRM record per
 *     canonical LinkedIn identity, end to end.
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { buildTestAuth, buildTestAuthEnv, grantSystemMemberRole } from "@skout/auth";
import type { FastifyInstance } from "fastify";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const OWNER_ID = randomUUID();
const MEMBER_ID = randomUUID();
const OUTSIDER_ID = randomUUID();

let app: FastifyInstance;
let owner: Record<string, string>;
let member: Record<string, string>;
let outsider: Record<string, string>;

async function provisionUser(workspaceId: string, userId: string, role: "owner" | "member") {
  const db = app.db!;
  const email = `capture-test-${userId}@example.com`;
  await db.insert(schema.users).values({ id: userId, email, fullName: "Capture Test User", status: "active" }).onConflictDoNothing();
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId, role }).onConflictDoNothing();
  if (!(await grantSystemMemberRole(db, workspaceId, userId, role))) {
    throw new Error("System roles are not seeded; run the RBAC backfill before tests");
  }
  const auth = buildTestAuth({ workspaceId, userId, email, role });
  return { "x-workspace-id": workspaceId, "content-type": "application/json", Authorization: auth.bearer };
}

beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), LOG_LEVEL: "fatal" as const, ...buildTestAuthEnv() });
  const db = app.db;
  if (!db) throw new Error("database_unavailable");
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.insert(schema.workspaces).values({ id, name: "Capture test", slug: `capture-test-${id}` });
  }
  // Keep the seeded owner role aligned with the enrichment verbs, as the RBAC backfill does.
  const [ownerRole] = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.key, "owner"), isNull(schema.roles.workspaceId)))
    .limit(1);
  const permissions = await db
    .select({ key: schema.permissions.key })
    .from(schema.permissions)
    .where(like(schema.permissions.key, "enrichment:%"));
  for (const permission of permissions) {
    await db.insert(schema.rolePermissions).values({ roleId: ownerRole!.id, permissionKey: permission.key }).onConflictDoNothing();
  }
  owner = await provisionUser(WORKSPACE, OWNER_ID, "owner");
  member = await provisionUser(WORKSPACE, MEMBER_ID, "member");
  outsider = await provisionUser(OTHER_WORKSPACE, OUTSIDER_ID, "owner");
}, 60000);

afterAll(async () => {
  if (app?.db) {
    await app.db.delete(schema.workspaces).where(eq(schema.workspaces.id, WORKSPACE)).catch(() => undefined);
    await app.db.delete(schema.workspaces).where(eq(schema.workspaces.id, OTHER_WORKSPACE)).catch(() => undefined);
  }
  await app?.close();
});

const post = (url: string, payload: unknown, headers = owner) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as object });
const get = (url: string, headers = owner) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const setCapture = (payload: unknown, headers = owner) =>
  app.inject({ method: "PUT", url: "/api/v1/enrichment/capture/settings", headers, payload: payload as object });

const SALES_URL = "https://www.linkedin.com/sales/search/people?query=(filters:List())";

function salesLead(index: number, overrides: Record<string, unknown> = {}) {
  const leadUrl = `https://www.linkedin.com/sales/lead/lead${index},NAME_SEARCH,x`;
  return {
    publicId: `sales-lead:lead${index}`,
    sourceUrl: leadUrl,
    fullName: `Visible lead ${index}`,
    headline: "HR associate at Blinkit",
    currentCompanies: [{ name: "Blinkit", title: "HR associate", companyPublicId: "80918929" }],
    relationshipContext: { salesNavigatorLeadUrl: leadUrl },
    ...overrides,
  };
}

const salesPayload = (count: number, extra: Record<string, unknown> = {}) => ({
  sourceUrl: SALES_URL,
  pagesRead: 8,
  filters: ["current company: Blinkit (included)", "function: Human Resources (included)"],
  peopleProfiles: Array.from({ length: count }, (_, index) => salesLead(index)),
  ...extra,
});

async function contactCount(workspaceId = WORKSPACE) {
  const rows = await app.db!
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.workspaceId, workspaceId), isNull(schema.contacts.deletedAt)));
  return rows.length;
}

describe("ENR-02 capture ingest", () => {
  it("requires authentication and the capture permission", async () => {
    const anonymous = await app.inject({ method: "POST", url: "/api/v1/enrichment/ingest/sales-search", payload: salesPayload(1) });
    expect(anonymous.statusCode).toBe(401);
    const settings = await setCapture({ enabled: false }, member);
    expect(settings.statusCode).toBe(403);
  });

  it("accepts the eight-page, 183-lead Sales search and records a terminal run", async () => {
    const res = await post("/enrichment/ingest/sales-search", salesPayload(183));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.run).toMatchObject({ kind: "sales_search", status: "completed", terminal: true, pagesRead: 8, leadsReceived: 183, leadsCreated: 183 });
    expect(body.run.completedAt).toBeTruthy();
    expect(await contactCount()).toBe(183);
  });

  it("merges a repeated department search by identity instead of adding duplicate people", async () => {
    const res = await post("/enrichment/ingest/sales-search", salesPayload(183));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: 0, merged: 183 });
    expect(await contactCount()).toBe(183);
  });

  it("enforces the 10-page and 250-lead caps", async () => {
    expect((await post("/enrichment/ingest/sales-search", salesPayload(251))).statusCode).toBe(422);
    expect((await post("/enrichment/ingest/sales-search", salesPayload(1, { pagesRead: 11 }))).statusCode).toBe(422);

    const started = await post("/enrichment/capture/runs", { kind: "sales_search", sourceUrl: SALES_URL, clientRunId: `caps-${randomUUID()}` });
    expect(started.statusCode).toBe(201);
    const runId = started.json().run.id as string;
    const batch = (count: number, pagesRead: number) =>
      post("/enrichment/ingest/sales-search", { ...salesPayload(count, { pagesRead }), runId });
    expect((await batch(150, 6)).statusCode).toBe(201);
    const overLeads = await batch(101, 1);
    expect(overLeads.statusCode).toBe(422);
    expect(overLeads.json().code).toBe("lead_cap_exceeded");
    const overPages = await batch(10, 5);
    expect(overPages.statusCode).toBe(422);
    expect(overPages.json().code).toBe("page_cap_exceeded");
    const finished = await post(`/enrichment/capture/runs/${runId}/finish`, { status: "completed" });
    expect(finished.json().run).toMatchObject({ status: "completed", leadsReceived: 150, pagesRead: 6 });
    // A finished run accepts nothing more and reports the state already recorded.
    expect((await batch(1, 1)).statusCode).toBe(409);
    expect((await post(`/enrichment/capture/runs/${runId}/finish`, { status: "failed" })).json().run.status).toBe("completed");
  });

  it("never stores a public profile URL that the capture did not show", async () => {
    const fabricated = await post("/enrichment/ingest/sales-search", {
      ...salesPayload(0),
      peopleProfiles: [salesLead(900, { publicId: "lead900", sourceUrl: "https://www.linkedin.com/sales/lead/lead900,NAME_SEARCH,x" })],
    });
    expect(fabricated.statusCode).toBe(422);
    const mismatched = await post("/enrichment/ingest/sales-search", {
      ...salesPayload(0),
      peopleProfiles: [salesLead(901, { publicId: "someone-else", sourceUrl: "https://www.linkedin.com/in/real-person/" })],
    });
    expect(mismatched.statusCode).toBe(422);

    const [identity] = await app.db!
      .select()
      .from(schema.enrichmentIdentities)
      .where(and(eq(schema.enrichmentIdentities.workspaceId, WORKSPACE), eq(schema.enrichmentIdentities.canonicalKey, "sales-lead:lead0")));
    const [contact] = await app.db!.select().from(schema.contacts).where(eq(schema.contacts.id, identity!.entityId));
    expect(contact!.linkedinUrl).toBeNull();
    expect(contact!.employmentStatus).toBe("discovery_candidate");
  });

  it("attaches a real public link to the same Sales lead once one is visible", async () => {
    const before = await contactCount();
    const res = await post("/enrichment/ingest/sales-search", {
      ...salesPayload(0, { pagesRead: 1 }),
      peopleProfiles: [salesLead(0, { publicId: "visible-lead-zero", sourceUrl: "https://www.linkedin.com/in/visible-lead-zero/" })],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: 0, merged: 1 });
    expect(await contactCount()).toBe(before);
    const identities = await app.db!
      .select()
      .from(schema.enrichmentIdentities)
      .where(and(eq(schema.enrichmentIdentities.workspaceId, WORKSPACE), eq(schema.enrichmentIdentities.entityType, "person")));
    const lead = identities.find((row) => row.canonicalKey === "sales-lead:lead0")!;
    const publicIdentity = identities.find((row) => row.canonicalKey === "in:visible-lead-zero")!;
    expect(publicIdentity.entityId).toBe(lead.entityId);
    const [contact] = await app.db!.select().from(schema.contacts).where(eq(schema.contacts.id, lead.entityId));
    expect(contact!.linkedinUrl).toBe("https://www.linkedin.com/in/visible-lead-zero/");
  });

  const person = (overrides: Record<string, unknown> = {}) => ({
    publicId: "jane-doe-3b2a1",
    sourceUrl: "https://www.linkedin.com/in/jane-doe-3b2a1/",
    fullName: "Jane Doe",
    headline: "VP Sales at Acme Robotics",
    summary: "Builds revenue teams.",
    locationName: "Austin, Texas, United States",
    currentCompanyPublicId: "acme-robotics",
    currentCompanies: [{ name: "Acme Robotics", title: "VP Sales", dates: "Jan 2023 - Present", companyPublicId: "acme-robotics" }],
    previousCompanies: [
      { name: "Globex", title: "Sales Director", dates: "2019 - 2022" },
      { name: "Ad Options", title: "Why am I seeing this ad?" },
    ],
    educations: [{ school: "University of Texas", degree: "BBA" }],
    skills: [{ name: "Enterprise Sales", endorsements: 12 }, { name: "Endorsed by 3 colleagues at Globex" }, "People you may know"],
    ...overrides,
  });

  it("stores a public profile with experience, education and skills, minus page chrome", async () => {
    const res = await post("/enrichment/ingest/person", person());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.run).toMatchObject({ kind: "person", status: "completed", leadsCreated: 1 });
    expect(body.rejectedFields).toEqual(expect.arrayContaining(["skills[1]", "skills[2]", "previousCompanies[1]"]));

    const [contact] = await app.db!.select().from(schema.contacts).where(eq(schema.contacts.id, body.person.contactId));
    expect(contact).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      title: "VP Sales",
      linkedinUrl: "https://www.linkedin.com/in/jane-doe-3b2a1/",
      employmentStatus: "verified_employment",
    });
    const [activation] = await app.db!
      .select()
      .from(schema.prospectActivations)
      .where(and(eq(schema.prospectActivations.workspaceId, WORKSPACE), eq(schema.prospectActivations.prospectId, body.person.prospectId)));
    const snapshot = activation!.snapshot as Record<string, unknown>;
    expect(snapshot.skills).toEqual([{ name: "Enterprise Sales", endorsements: 12 }]);
    expect(snapshot.previousCompanies).toHaveLength(1);
    expect(snapshot.educations).toHaveLength(1);
    expect(snapshot.sourceUrl).toBe("https://www.linkedin.com/in/jane-doe-3b2a1/");
    expect(snapshot.capturedAt).toBeTruthy();
  });

  it("rejects a capture whose name is page chrome or whose URL does not match", async () => {
    const chrome = await post("/enrichment/ingest/person", person({ fullName: "People you may know" }));
    expect(chrome.statusCode).toBe(422);
    expect(chrome.json().code).toBe("profile_not_readable");
    const mismatch = await post("/enrichment/ingest/person", person({ publicId: "someone-else" }));
    expect(mismatch.statusCode).toBe(422);
    const unknownField = await post("/enrichment/ingest/person", person({ email: "jane@example.com" }));
    expect(unknownField.statusCode).toBe(422);
  });

  it("is idempotent on the canonical profile key and records a job change", async () => {
    const before = await contactCount();
    const same = await post("/enrichment/ingest/person", person());
    expect(same.json()).toMatchObject({ created: 0, merged: 1 });
    const moved = await post(
      "/enrichment/ingest/person",
      person({ headline: "CRO at Acme Robotics", currentCompanies: [{ name: "Acme Robotics", title: "CRO", dates: "Jun 2026 - Present", companyPublicId: "acme-robotics" }] })
    );
    expect(moved.statusCode).toBe(201);
    expect(await contactCount()).toBe(before);
    const changes = await app.db!
      .select()
      .from(schema.enrichmentChangeEvents)
      .where(and(eq(schema.enrichmentChangeEvents.workspaceId, WORKSPACE), eq(schema.enrichmentChangeEvents.entityId, moved.json().person.prospectId)));
    expect(changes.some((change) => change.field === "currentCompanies" && change.isJobChange)).toBe(true);
    // The unchanged re-capture did not add history of its own.
    expect(changes.every((change) => change.field !== "educations")).toBe(true);
  });

  it("captures a company into the placeholder its employee created and keeps people as candidates", async () => {
    const res = await post("/enrichment/ingest/company", {
      publicId: "acme-robotics",
      memberId: "424242",
      sourceUrl: "https://www.linkedin.com/company/acme-robotics/about/",
      name: "Acme Robotics",
      website: "https://www.acmerobotics.example/",
      industry: "Robotics",
      headquarter: "Austin, Texas",
      employeesOnLi: 1141,
      pagesRead: 2,
      sectionCaptures: {
        about: { text: "Acme builds robots.", sourceUrl: "https://www.linkedin.com/company/acme-robotics/about/", capturedAt: new Date().toISOString(), method: "rendered-dom" },
      },
      peopleProfiles: [
        { publicId: "jane-doe-3b2a1", sourceUrl: "https://www.linkedin.com/in/jane-doe-3b2a1/", fullName: "Jane Doe", headline: "Thinner card headline", associationSource: "company-people-page" },
        { publicId: "sam-lee", sourceUrl: "https://www.linkedin.com/in/sam-lee/", fullName: "Sam Lee", headline: "Engineer", associationSource: "company-search-result" },
        { publicId: "ad-card", sourceUrl: "https://www.linkedin.com/in/ad-card/", fullName: "Suggested for you" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.company.created).toBe(false);
    expect(body).toMatchObject({ received: 3, created: 1, merged: 1, rejected: 1 });
    expect(body.run).toMatchObject({ status: "completed", pagesRead: 2 });

    const named = await app.db!
      .select()
      .from(schema.companies)
      .where(and(eq(schema.companies.workspaceId, WORKSPACE), eq(schema.companies.name, "Acme Robotics")));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ domain: "acmerobotics.example", industry: "Robotics", employeeCount: 1141 });

    const contactsAtCompany = await app.db!
      .select()
      .from(schema.contacts)
      .where(and(eq(schema.contacts.workspaceId, WORKSPACE), eq(schema.contacts.companyId, named[0]!.id)));
    const jane = contactsAtCompany.find((row) => row.firstName === "Jane")!;
    const sam = contactsAtCompany.find((row) => row.firstName === "Sam")!;
    // A thinner card never replaces what the full profile recorded.
    expect(jane.title).toBe("CRO");
    expect(jane.employmentStatus).toBe("verified_employment");
    expect(sam.employmentStatus).toBe("discovery_candidate");

    const ids = await get("/enrichment/ingest/company/acme-robotics/captured-profile-ids");
    expect(ids.json().publicIds.sort()).toEqual(["jane-doe-3b2a1", "sam-lee"]);
  });

  it("keeps capture runs and records inside the workspace", async () => {
    const runs = await get("/enrichment/capture/runs");
    expect(runs.statusCode).toBe(200);
    const runId = runs.json().runs[0].id as string;
    expect(runs.json().runs.every((run: { terminal: boolean }) => run.terminal)).toBe(true);
    expect((await get(`/enrichment/capture/runs/${runId}`, outsider)).statusCode).toBe(404);
    expect((await get("/enrichment/capture/runs", outsider)).json().total).toBe(0);
    expect(await contactCount(OTHER_WORKSPACE)).toBe(0);
    // Another member cannot write into someone else's run.
    const started = await post("/enrichment/capture/runs", { kind: "person" });
    const foreign = await post("/enrichment/ingest/person", { ...person(), runId: started.json().run.id }, member);
    expect(foreign.statusCode).toBe(404);
    await post(`/enrichment/capture/runs/${started.json().run.id}/finish`, { status: "stopped", reason: "test" });
  });

  it("halts capture within one request when the kill switch is turned on", async () => {
    const started = await post("/enrichment/capture/runs", { kind: "sales_search", sourceUrl: SALES_URL });
    const runId = started.json().run.id as string;
    const lead = (index: number) => ({ ...salesPayload(0, { pagesRead: 1 }), runId, peopleProfiles: [salesLead(index)] });
    expect((await post("/enrichment/ingest/sales-search", lead(500))).statusCode).toBe(201);

    const disabled = await setCapture({ enabled: false, reason: "LinkedIn warning under review" });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().enabled).toBe(false);

    const before = await contactCount();
    const next = await post("/enrichment/ingest/sales-search", lead(501));
    expect(next.statusCode).toBe(403);
    expect(next.json()).toMatchObject({ code: "capture_disabled", error: "LinkedIn warning under review", run: { status: "halted", terminal: true } });
    expect(await contactCount()).toBe(before);

    expect((await post("/enrichment/capture/runs", { kind: "person" })).json().code).toBe("capture_disabled");
    expect((await post("/enrichment/ingest/person", person({ publicId: "new-person", sourceUrl: "https://www.linkedin.com/in/new-person/" }))).statusCode).toBe(403);
    const legacy = await post("/prospects/activate", { prospects: [{ fullName: "Legacy Path", companyDomain: "legacy.linkedin", linkedinUrl: "https://www.linkedin.com/in/legacy-path" }] });
    expect(legacy.statusCode).toBe(403);
    expect((await get("/enrichment/capture/status")).json()).toMatchObject({ enabled: false, disabledReason: "LinkedIn warning under review" });

    expect((await setCapture({ enabled: true })).json().enabled).toBe(true);
    // The halted run stays halted; a new capture works again.
    expect((await post("/enrichment/ingest/sales-search", lead(502))).statusCode).toBe(409);
    expect((await post("/enrichment/ingest/sales-search", { ...lead(502), runId: undefined })).statusCode).toBe(201);
  });

  it("enforces the per-user daily volume limit", async () => {
    const status = (await get("/enrichment/capture/status")).json();
    expect(status.caps).toMatchObject({ maxPagesPerRun: 10, maxLeadsPerRun: 250, dailyLeadLimit: 1000 });
    const used = status.usage.leadsToday as number;
    expect(used).toBeGreaterThan(366);

    await setCapture({ dailyLeadLimit: used + 2 });
    const overflow = await post("/enrichment/ingest/sales-search", { ...salesPayload(0, { pagesRead: 1 }), peopleProfiles: [salesLead(600), salesLead(601), salesLead(602)] });
    expect(overflow.statusCode).toBe(429);
    expect(overflow.json()).toMatchObject({ code: "daily_limit_reached", run: { status: "rejected" } });
    const fits = await post("/enrichment/ingest/sales-search", { ...salesPayload(0, { pagesRead: 1 }), peopleProfiles: [salesLead(600), salesLead(601)] });
    expect(fits.statusCode).toBe(201);
    expect((await post("/enrichment/capture/runs", { kind: "person" })).statusCode).toBe(429);
    // The limit is per user: another member of the workspace is unaffected.
    expect((await get("/enrichment/capture/status", member)).json().usage.leadsToday).toBe(0);
    await setCapture({ dailyLeadLimit: 1000 });
  });
});
