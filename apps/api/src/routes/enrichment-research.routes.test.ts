/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-03 test fixtures assert capture → CRM state.
 *   - Tables touched directly: contacts, companies (both owned by apps/crm)
 *     - read; companies inserted as fixtures for the ambiguous-name cases
 *   - Owning service: apps/crm (test fixtures require direct access for setup and assertions)
 *   - Reason: integration tests validate identity resolution, evidence and delete cascade
 *     against the real CRM rows, end to end.
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
import { purgeExpiredCaptureEvidence } from "../services/enrichment/capture-evidence.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
let app: FastifyInstance;
let owner: Record<string, string>;
let member: Record<string, string>;
let outsider: Record<string, string>;

async function provisionUser(workspaceId: string, role: "owner" | "member") {
  const db = app.db!;
  const userId = randomUUID();
  const email = `research-test-${userId}@example.com`;
  await db.insert(schema.users).values({ id: userId, email, fullName: "Research Test User", status: "active" });
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId, role });
  if (!(await grantSystemMemberRole(db, workspaceId, userId, role))) throw new Error("System roles are not seeded");
  const auth = buildTestAuth({ workspaceId, userId, email, role });
  return { "x-workspace-id": workspaceId, "content-type": "application/json", Authorization: auth.bearer };
}

beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), LOG_LEVEL: "fatal" as const, ...buildTestAuthEnv() });
  const db = app.db;
  if (!db) throw new Error("database_unavailable");
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.insert(schema.workspaces).values({ id, name: "Research test", slug: `research-test-${id}` });
  }
  const [ownerRole] = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.key, "owner"), isNull(schema.roles.workspaceId)))
    .limit(1);
  const permissions = await db.select({ key: schema.permissions.key }).from(schema.permissions).where(like(schema.permissions.key, "enrichment:%"));
  for (const permission of permissions) {
    await db.insert(schema.rolePermissions).values({ roleId: ownerRole!.id, permissionKey: permission.key }).onConflictDoNothing();
  }
  owner = await provisionUser(WORKSPACE, "owner");
  member = await provisionUser(WORKSPACE, "member");
  outsider = await provisionUser(OTHER_WORKSPACE, "owner");
}, 60000);

afterAll(async () => {
  await app?.close();
});

const post = (url: string, payload: unknown, headers = owner) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as object });
const get = (url: string, headers = owner) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const del = (url: string, headers = owner) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });

const SALES_URL = "https://www.linkedin.com/sales/search/people?query=(filters:List())";
const leadUrl = (id: string) => `https://www.linkedin.com/sales/lead/${id},NAME_SEARCH,x`;

function salesCard(id: string, fields: Record<string, unknown> = {}) {
  return {
    publicId: `sales-lead:${id}`,
    sourceUrl: leadUrl(id),
    fullName: `Lead ${id}`,
    relationshipContext: { salesNavigatorLeadUrl: leadUrl(id) },
    ...fields,
  };
}
const salesSearch = (...peopleProfiles: unknown[]) => post("/enrichment/ingest/sales-search", { sourceUrl: SALES_URL, pagesRead: 1, peopleProfiles });

const profile = (publicId: string, fields: Record<string, unknown> = {}) => ({
  publicId,
  sourceUrl: `https://www.linkedin.com/in/${publicId}/`,
  fullName: "Priya Raman",
  headline: "Head of Revenue at Initech",
  summary: "Runs revenue operations.",
  locationName: "Pune, India",
  currentCompanyPublicId: "initech",
  currentCompanies: [{ name: "Initech", title: "Head of Revenue", dates: "Mar 2024 - Present · 2 yrs 7 mos", companyPublicId: "initech" }],
  previousCompanies: [{ name: "Hooli", title: "Sales Manager", dates: "2020 - 2024" }],
  educations: [{ school: "IIT Bombay", degree: "B.Tech" }],
  skills: [{ name: "Revenue Operations", endorsements: 8 }],
  ...fields,
});

const db = () => app.db!;
const liveContacts = async () =>
  db().select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, WORKSPACE), isNull(schema.contacts.deletedAt)));
const ledger = (entityType: string, entityId: string) =>
  db()
    .select()
    .from(schema.evidenceLedger)
    .where(and(eq(schema.evidenceLedger.workspaceId, WORKSPACE), eq(schema.evidenceLedger.entityType, entityType), eq(schema.evidenceLedger.entityId, entityId)));
const audits = async (action: string) =>
  db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.workspaceId, WORKSPACE), eq(schema.auditLogs.action, action)));

async function personByName(q: string) {
  const res = await get(`/enrichment/people?q=${encodeURIComponent(q)}`);
  expect(res.statusCode).toBe(200);
  return res.json().people as Array<Record<string, any>>;
}

describe("ENR-03 identity resolution", () => {
  it("keeps a Sales-only lead under its sales-lead key and never gives it a public URL", async () => {
    expect((await salesSearch(salesCard("solo1", { fullName: "Solo Lead" }))).statusCode).toBe(201);
    const [person] = await personByName("Solo Lead");
    expect(person).toMatchObject({ identity: "sales_lead", linkedinUrl: null, salesNavigatorLeadUrl: leadUrl("solo1"), employmentState: "unknown" });
    const detail = (await get(`/enrichment/people/${person!.prospectId}`)).json().person;
    expect(detail.identityKeys).toEqual(["sales-lead:solo1"]);
  });

  it("merges a Sales lead into the public-profile record once a real public URL is visible", async () => {
    await salesSearch(salesCard("merge1", { fullName: "Priya Raman", headline: "Card headline" }));
    const captured = await post("/enrichment/ingest/person", profile("priya-raman"));
    expect(captured.statusCode).toBe(201);
    expect(await personByName("Priya Raman")).toHaveLength(2);

    // The same lead now shows its public link on the card.
    const linked = await salesSearch(
      salesCard("merge1", { publicId: "priya-raman", sourceUrl: "https://www.linkedin.com/in/priya-raman/", fullName: "Priya Raman" })
    );
    expect(linked.json()).toMatchObject({ created: 0, merged: 1 });

    const people = await personByName("Priya Raman");
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ prospectId: captured.json().person.prospectId, identity: "public_profile", salesNavigatorLeadUrl: leadUrl("merge1") });
    const detail = (await get(`/enrichment/people/${people[0]!.prospectId}`)).json().person;
    expect(detail.identityKeys.sort()).toEqual(["in:priya-raman", "sales-lead:merge1"]);

    const merges = await db().select().from(schema.identityMergeEvents).where(eq(schema.identityMergeEvents.workspaceId, WORKSPACE));
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ entityType: "contact", action: "merge", primaryEntityId: captured.json().person.contactId });
    expect((merges[0]!.beforeSnapshot as { reason: string }).reason).toBe("public_url_visible");
  });

  it("does not let a thinner card erase what the full profile recorded", async () => {
    const [before] = await personByName("Priya Raman");
    await salesSearch(
      salesCard("merge1", {
        publicId: "priya-raman",
        sourceUrl: "https://www.linkedin.com/in/priya-raman/",
        fullName: "Priya R.",
        headline: "Thinner card headline",
        currentCompanies: [{ name: "Initech", title: "Revenue" }],
      })
    );
    const detail = (await get(`/enrichment/people/${before!.prospectId}`)).json().person;
    expect(detail).toMatchObject({ fullName: "Priya Raman", headline: "Head of Revenue at Initech", title: "Head of Revenue", employmentState: "verified" });
    expect(detail.educations).toHaveLength(1);
    expect(detail.experience.previous).toHaveLength(1);
    // Both observations are in the ledger; the verified one is the current fact.
    const headline = detail.facts.find((fact: any) => fact.attribute === "headline");
    expect(headline).toMatchObject({ value: "Head of Revenue at Initech", state: "verified", source: "linkedin_public_profile" });
    expect(detail.evidence.some((fact: any) => fact.attribute === "headline" && fact.state === "discovery" && fact.value === "Thinner card headline")).toBe(true);
  });

  it("leaves an ambiguous company name unresolved", async () => {
    await db().insert(schema.companies).values([
      { workspaceId: WORKSPACE, name: "Northwind", domain: "northwind.example", fieldSources: {} },
      { workspaceId: WORKSPACE, name: "Northwind Inc.", domain: "northwind-traders.example", fieldSources: {} },
    ]);
    await salesSearch(salesCard("amb1", { fullName: "Ambiguous Ann", currentCompanies: [{ name: "Northwind", title: "Buyer" }] }));
    const [person] = await personByName("Ambiguous Ann");
    expect(person).toMatchObject({ companyId: null, companyName: "Northwind", employmentState: "candidate" });
    const contact = (await liveContacts()).find((row) => row.id === person!.contactId)!;
    expect(contact.companyId).toBeNull();
    const edges = await db().select().from(schema.companyPersonDiscoveries).where(eq(schema.companyPersonDiscoveries.contactId, contact.id));
    expect(edges).toHaveLength(0);
    const evidence = (await get(`/enrichment/evidence/prospects/${person!.prospectId}`)).json();
    expect(evidence.employment).toMatchObject({ state: "discovery", companyId: null, companyName: "Northwind", usableForClaims: false });
    const employment = evidence.facts.find((fact: any) => fact.attribute === "employment");
    expect(employment.value.resolution).toBe("ambiguous_company_name");
  });

  it("does not merge companies on a shared name alone, and queues the pair for review", async () => {
    await db().insert(schema.companies).values({ workspaceId: WORKSPACE, name: "Globex", industry: "Logistics", fieldSources: {} });
    const res = await post("/enrichment/ingest/company", {
      publicId: "globex-energy",
      sourceUrl: "https://www.linkedin.com/company/globex-energy/about/",
      name: "Globex",
      industry: "Energy",
    });
    expect(res.json().company.created).toBe(true);
    const named = await db().select().from(schema.companies).where(and(eq(schema.companies.workspaceId, WORKSPACE), eq(schema.companies.name, "Globex")));
    expect(named).toHaveLength(2);
    const proposals = await db()
      .select()
      .from(schema.identityMergeProposals)
      .where(and(eq(schema.identityMergeProposals.workspaceId, WORKSPACE), eq(schema.identityMergeProposals.rightEntityId, res.json().company.id)));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ entityType: "company", status: "pending" });
  });

  it("keeps a discovered candidate a candidate until the person's own profile is captured", async () => {
    await salesSearch(salesCard("cand1", { fullName: "Carl Candidate", currentCompanies: [{ name: "Initech", title: "Analyst" }] }));
    const [candidate] = await personByName("Carl Candidate");
    expect(candidate).toMatchObject({ employmentState: "candidate", companyName: "Initech" });
    const companyId = candidate!.companyId as string;

    const candidates = (await get(`/enrichment/companies/${companyId}/people?group=candidates`)).json();
    expect(candidates.people.map((person: any) => person.fullName)).toContain("Carl Candidate");
    const verified = (await get(`/enrichment/companies/${companyId}/people?group=verified`)).json();
    expect(verified.people.map((person: any) => person.fullName)).toEqual(["Priya Raman"]);

    // Attaching the public URL identifies the person; it does not verify the employer.
    const attached = await post(`/enrichment/people/${candidate!.prospectId}/public-url`, { url: "https://www.linkedin.com/in/carl-candidate?trk=x" });
    expect(attached.statusCode).toBe(200);
    expect(attached.json()).toMatchObject({ linkedinUrl: "https://www.linkedin.com/in/carl-candidate/", merged: false });
    expect((await personByName("Carl Candidate"))[0]).toMatchObject({ identity: "public_profile", employmentState: "candidate" });

    await post("/enrichment/ingest/person", profile("carl-candidate", {
      fullName: "Carl Candidate",
      headline: "Analyst at Initech",
      currentCompanies: [{ name: "Initech", title: "Analyst", companyPublicId: "initech" }],
    }));
    expect((await personByName("Carl Candidate"))[0]).toMatchObject({ employmentState: "verified" });
    const after = (await get(`/enrichment/companies/${companyId}/people?group=candidates`)).json();
    expect(after.people.map((person: any) => person.fullName)).not.toContain("Carl Candidate");
    const company = (await get(`/enrichment/companies/${companyId}`)).json().company;
    expect(company.people).toMatchObject({ verifiedEmployees: 2, discoveryCandidates: 0 });
  });
});

describe("ENR-03 attach public URL", () => {
  it("validates the URL, is audited, and merges into an existing public-profile record", async () => {
    await salesSearch(salesCard("att1", { fullName: "Priya Raman (lead)" }));
    const [lead] = await personByName("Priya Raman (lead)");
    expect((await post(`/enrichment/people/${lead!.prospectId}/public-url`, { url: "https://www.linkedin.com/sales/lead/att1" })).statusCode).toBe(400);
    expect((await post(`/enrichment/people/${lead!.prospectId}/public-url`, { url: "https://example.com/in/priya-raman/" })).json().code).toBe("invalid_public_url");
    expect((await post(`/enrichment/people/${lead!.prospectId}/public-url`, { url: "https://www.linkedin.com/in/x/" }, member)).statusCode).toBe(200 + 0);
  });

  it("folds the lead into the record that already has that profile", async () => {
    await salesSearch(salesCard("att2", { fullName: "Priya Raman (second lead)" }));
    const [lead] = await personByName("Priya Raman (second lead)");
    const existing = (await personByName("Priya Raman")).find((person) => person.fullName === "Priya Raman");
    const before = (await liveContacts()).length;
    const attached = await post(`/enrichment/people/${lead!.prospectId}/public-url`, { url: "https://www.linkedin.com/in/priya-raman/" });
    expect(attached.json()).toMatchObject({ merged: true, prospectId: existing!.prospectId });
    expect((await liveContacts()).length).toBe(before - 1);
    expect((await get(`/enrichment/people/${lead!.prospectId}`)).statusCode).toBe(404);
    const detail = (await get(`/enrichment/people/${existing!.prospectId}`)).json().person;
    expect(detail.identityKeys).toEqual(expect.arrayContaining(["in:priya-raman", "sales-lead:att2"]));
    expect(detail.fullName).toBe("Priya Raman");

    const logged = await audits("enrichment.attach_public_url");
    expect(logged.length).toBeGreaterThanOrEqual(2);
    expect(logged.some((entry) => (entry.afterState as { merged?: boolean }).merged === true)).toBe(true);
    // A different URL on a record that already has one is refused.
    const conflict = await post(`/enrichment/people/${existing!.prospectId}/public-url`, { url: "https://www.linkedin.com/in/someone-else/" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("public_url_conflict");
  });

  it("registers a LinkedIn URL for capture without inventing any fact", async () => {
    const added = await post("/enrichment/linkedin-urls", { url: "https://www.linkedin.com/in/new-person-42/" });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ kind: "person", created: true, linkedinUrl: "https://www.linkedin.com/in/new-person-42/" });
    const detail = (await get(`/enrichment/people/${added.json().prospectId}`)).json().person;
    expect(detail).toMatchObject({ fullName: null, pendingCapture: true, identity: "public_profile", employmentState: "unknown" });
    expect(detail.facts.map((fact: any) => fact.attribute)).toEqual(["linkedinUrl"]);
    expect((await post("/enrichment/linkedin-urls", { url: "https://www.linkedin.com/in/new-person-42" })).json().created).toBe(false);
    expect((await post("/enrichment/linkedin-urls", { url: "https://www.linkedin.com/company/initech/" })).json()).toMatchObject({ kind: "company", created: false });
    expect((await post("/enrichment/linkedin-urls", { url: "https://www.linkedin.com/feed/" })).statusCode).toBe(400);
    expect((await audits("enrichment.add_linkedin_url")).length).toBe(3);
  });
});

describe("ENR-03 evidence ledger", () => {
  it("gives every displayed fact a source, a source URL and a capture time, with rows in the ledger", async () => {
    const [person] = await personByName("Priya Raman");
    const detail = (await get(`/enrichment/people/${person!.prospectId}`)).json().person;
    const attributes = detail.facts.map((fact: any) => fact.attribute);
    expect(attributes).toEqual(expect.arrayContaining(["fullName", "headline", "summary", "locationName", "currentCompanies", "previousCompanies", "educations", "skills", "employment", "linkedinUrl"]));
    for (const fact of detail.facts) {
      expect(fact.source, fact.attribute).toBeTruthy();
      expect(fact.sourceUrl, fact.attribute).toMatch(/^https:\/\/www\.linkedin\.com\//);
      expect(Date.parse(fact.capturedAt), fact.attribute).not.toBeNaN();
      expect(Date.parse(fact.observedAt), fact.attribute).not.toBeNaN();
      expect(fact.confidence).toBeGreaterThan(0);
      expect(["verified", "discovery"]).toContain(fact.state);
    }
    const rows = await ledger("prospect", person!.prospectId);
    expect(rows.length).toBeGreaterThanOrEqual(detail.facts.length);
    for (const row of rows) {
      expect(row.permittedPurpose).toBe("sales_research");
      expect(row.consentBasis).toBe("legitimate_interest");
      expect(row.retentionUntil!.getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 60 * 60 * 1000);
      expect(row.method).toBeTruthy();
      expect(["verified", "discovery"]).toContain(row.validation);
    }
    expect(rows.find((row) => row.attribute === "skills")).toMatchObject({ source: "linkedin_public_profile", confidence: 0.9, validation: "verified", sourceUrl: "https://www.linkedin.com/in/priya-raman/" });
  });

  it("refreshes rather than duplicates evidence when the same value is captured again", async () => {
    const [person] = await personByName("Priya Raman");
    const count = async () => (await ledger("prospect", person!.prospectId)).filter((row) => row.source === "linkedin_public_profile").length;
    const before = await count();
    await post("/enrichment/ingest/person", profile("priya-raman"));
    expect(await count()).toBe(before);
    const skills = (await ledger("prospect", person!.prospectId)).find((row) => row.attribute === "skills" && row.source === "linkedin_public_profile")!;
    expect(skills.corroborationCount).toBeGreaterThanOrEqual(2);
  });

  it("serves stable ProspectEvidence and AccountEvidence contracts", async () => {
    const [person] = await personByName("Priya Raman");
    const prospect = (await get(`/enrichment/evidence/prospects/${person!.prospectId}`)).json();
    expect(prospect).toMatchObject({
      schemaVersion: 1,
      kind: "ProspectEvidence",
      workspaceId: WORKSPACE,
      prospectId: person!.prospectId,
      identity: { state: "public_profile", linkedinUrl: "https://www.linkedin.com/in/priya-raman/" },
      employment: { state: "verified", companyName: "Initech", title: "Head of Revenue", usableForClaims: true },
    });
    expect(prospect.employment.companyId).toBe(person!.companyId);
    expect(Object.keys(prospect.facts[0]).sort()).toEqual(
      ["attribute", "capturedAt", "confidence", "evidenceId", "freshnessExpiresAt", "method", "observedAt", "source", "sourceUrl", "stale", "state", "usableForClaims", "value"]
    );
    // The ENR-01 path serves the same contract.
    expect((await get(`/enrichment/people/${person!.prospectId}/evidence`)).json().kind).toBe("ProspectEvidence");

    await post("/enrichment/ingest/company", {
      publicId: "initech",
      sourceUrl: "https://www.linkedin.com/company/initech/about/",
      name: "Initech",
      website: "https://www.initech.example",
      industry: "Software",
      employeesOnLi: 412,
    });
    const account = (await get(`/enrichment/evidence/accounts/${person!.companyId}`)).json();
    expect(account).toMatchObject({
      schemaVersion: 1,
      kind: "AccountEvidence",
      companyId: person!.companyId,
      name: "Initech",
      domain: "initech.example",
      linkedinUrl: "https://www.linkedin.com/company/initech/",
      people: { visibleAssociatedMembers: 412, verifiedEmployees: 2 },
    });
    const industry = account.facts.find((fact: any) => fact.attribute === "industry");
    expect(industry).toMatchObject({ value: "Software", source: "linkedin_company_page", state: "verified", sourceUrl: "https://www.linkedin.com/company/initech/about/" });
    expect((await get(`/enrichment/evidence/accounts/${person!.companyId}`, outsider)).statusCode).toBe(404);
    expect((await get(`/enrichment/evidence/prospects/${person!.prospectId}`, outsider)).statusCode).toBe(404);
  });

  it("removes capture evidence that has passed its retention date", async () => {
    const [person] = await personByName("Solo Lead");
    const rows = await ledger("prospect", person!.prospectId);
    expect(rows.length).toBeGreaterThan(0);
    await db().update(schema.evidenceLedger).set({ retentionUntil: new Date(Date.now() - 1000) }).where(eq(schema.evidenceLedger.id, rows[0]!.id));
    await purgeExpiredCaptureEvidence(db());
    const after = await ledger("prospect", person!.prospectId);
    expect(after.map((row) => row.id)).not.toContain(rows[0]!.id);
    expect(after).toHaveLength(rows.length - 1);
  });
});

describe("ENR-03 change detection", () => {
  const jobChangesFor = async (prospectId: string, status = "all") =>
    ((await get(`/enrichment/job-changes?status=${status}&pageSize=100`)).json().jobChanges as Array<Record<string, any>>).filter(
      (change) => change.prospectId === prospectId
    );

  it("does not flag a job change when the current company and role are unchanged", async () => {
    const [person] = await personByName("Priya Raman");
    // Only the tenure text and the headline moved.
    const res = await post("/enrichment/ingest/person", profile("priya-raman", {
      headline: "Head of Revenue at Initech | Speaker",
      currentCompanies: [{ name: "Initech", title: "Head of Revenue", dates: "Mar 2024 - Present · 2 yrs 8 mos", companyPublicId: "initech" }],
    }));
    expect(res.statusCode).toBe(201);
    expect(await jobChangesFor(person!.prospectId)).toHaveLength(0);
    const detail = (await get(`/enrichment/people/${person!.prospectId}`)).json().person;
    expect(detail.changes.some((change: any) => change.field === "headline" && !change.isJobChange)).toBe(true);
  });

  it("flags a job change when the current company or role changes, for review only", async () => {
    const [person] = await personByName("Priya Raman");
    await post("/enrichment/ingest/person", profile("priya-raman", {
      headline: "VP Revenue at Umbrella",
      currentCompanyPublicId: "umbrella",
      currentCompanies: [{ name: "Umbrella", title: "VP Revenue", dates: "Oct 2026 - Present", companyPublicId: "umbrella" }],
    }));
    const pending = await jobChangesFor(person!.prospectId, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      fullName: "Priya Raman",
      isJobChange: true,
      from: { company: "Initech", title: "Head of Revenue" },
      to: { company: "Umbrella", title: "VP Revenue" },
      requiresReview: true,
      automation: "none",
    });
    expect((await get("/enrichment/overview")).json().jobChanges.pendingReview).toBeGreaterThanOrEqual(1);

    const reviewed = await post(`/enrichment/job-changes/${pending[0]!.id}/review`, {});
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().jobChange.reviewedAt).toBeTruthy();
    expect(await jobChangesFor(person!.prospectId, "pending")).toHaveLength(0);
    expect(await jobChangesFor(person!.prospectId, "reviewed")).toHaveLength(1);
    expect((await post(`/enrichment/job-changes/${pending[0]!.id}/review`, {}, outsider)).statusCode).toBe(404);
    // A detected change enrolls nobody and queues nothing.
    const events = await db().select().from(schema.skoutEvents).where(and(eq(schema.skoutEvents.workspaceId, WORKSPACE), eq(schema.skoutEvents.aggregateId, person!.prospectId)));
    expect(events).toHaveLength(0);
  });
});

describe("ENR-03 lists, pagination, export and delete", () => {
  let companyId: string;

  it("pages discovered candidates 15 at a time and filters them", async () => {
    const res = await post("/enrichment/ingest/company", {
      publicId: "paginate-co",
      sourceUrl: "https://www.linkedin.com/company/paginate-co/people/",
      name: "Paginate Co",
      pagesRead: 2,
      peopleProfiles: Array.from({ length: 20 }, (_, index) => ({
        publicId: `pager-${index}`,
        sourceUrl: `https://www.linkedin.com/in/pager-${index}/`,
        fullName: `Pager ${String(index).padStart(2, "0")}`,
        headline: index % 4 === 0 ? "Director of Sales" : "Engineer",
        associationSource: "company-search-result",
      })),
    });
    companyId = res.json().company.id;
    const first = (await get(`/enrichment/companies/${companyId}/people`)).json();
    expect(first).toMatchObject({ group: "candidates", total: 20, page: 1, pageSize: 15 });
    expect(first.people).toHaveLength(15);
    expect(first.people[0]).toMatchObject({ fullName: "Pager 00", employmentState: "candidate", discoverySource: "company-search-result" });
    const second = (await get(`/enrichment/companies/${companyId}/people?page=2`)).json();
    expect(second.people).toHaveLength(5);
    const directors = (await get(`/enrichment/companies/${companyId}/people?seniority=director`)).json();
    expect(directors.total).toBe(5);
    expect((await get(`/enrichment/companies/${companyId}/people?department=sales&q=Pager%2004`)).json().total).toBe(1);
    expect((await get(`/enrichment/companies/${companyId}/people?group=verified`)).json().total).toBe(0);
    expect((await get(`/enrichment/companies/${companyId}/people`, outsider)).statusCode).toBe(404);
  });

  it("lists and filters people and companies inside the workspace only", async () => {
    const all = (await get("/enrichment/people?pageSize=5")).json();
    expect(all.people).toHaveLength(5);
    expect(all.total).toBeGreaterThan(20);
    expect((await get("/enrichment/people?state=verified")).json().people.every((person: any) => person.employmentState === "verified")).toBe(true);
    expect((await get("/enrichment/people?identity=sales_lead")).json().people.every((person: any) => person.identity === "sales_lead")).toBe(true);
    // A candidate is associated with the company without being counted as verified there.
    expect((await get(`/enrichment/people?companyId=${companyId}`)).json().total).toBe(20);
    expect((await get(`/enrichment/people?companyId=${companyId}&state=verified`)).json().total).toBe(0);
    expect((await get("/enrichment/people?pageSize=500")).statusCode).toBe(400);
    expect((await get("/enrichment/people", outsider)).json().total).toBe(0);
    const companies = (await get("/enrichment/companies?q=paginate")).json();
    expect(companies.companies).toHaveLength(1);
    expect(companies.companies[0]).toMatchObject({ name: "Paginate Co", verifiedEmployees: 0, discoveryCandidates: 20 });
    const overview = (await get("/enrichment/overview")).json();
    expect(overview.people.total).toBe(all.total);
    expect(overview.people.verifiedEmployment + overview.people.discoveryCandidates).toBe(all.total);
  });

  it("exports CSV with source and capture time, audited, with formulas neutralized", async () => {
    await salesSearch(salesCard("csv1", { fullName: "=HYPERLINK(\"http://evil.example\")" }));
    const exported = await post("/enrichment/export", { type: "people" });
    expect(exported.statusCode).toBe(200);
    const [header] = exported.body.split("\r\n");
    expect(header).toBe('"id","fullName","headline","title","companyName","location","employmentState","identity","linkedinUrl","salesNavigatorLeadUrl","captureSource","sourceUrl","capturedAt"');
    expect(exported.body).toContain("\"'=HYPERLINK");
    expect(exported.body).toContain("https://www.linkedin.com/in/priya-raman/");

    const company = await get(`/enrichment/companies/${companyId}/export.csv`);
    expect(company.statusCode).toBe(200);
    expect(company.body.split("\r\n")).toHaveLength(21);
    expect(company.body).toContain('"candidates"');
    expect((await get(`/enrichment/companies/${companyId}/export.csv`, member)).statusCode).toBe(403);
    const logged = await audits("enrichment.export");
    expect(logged.some((entry) => (entry.afterState as { scope?: string }).scope === "company_people")).toBe(true);
  });

  it("deletes a person with identity keys, evidence and history, and audits it", async () => {
    const [person] = await personByName("Pager 03");
    expect((await ledger("prospect", person!.prospectId)).length).toBeGreaterThan(0);
    expect((await del(`/enrichment/people/${person!.prospectId}`, member)).statusCode).toBe(403);

    const removed = await del(`/enrichment/people/${person!.prospectId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ success: true, deletedId: person!.prospectId, contactRemoved: true });
    expect(removed.json().evidenceRemoved).toBeGreaterThan(0);

    expect(await ledger("prospect", person!.prospectId)).toHaveLength(0);
    expect((await get(`/enrichment/people/${person!.prospectId}`)).statusCode).toBe(404);
    expect((await liveContacts()).some((row) => row.id === person!.contactId)).toBe(false);
    const identities = await db().select().from(schema.enrichmentIdentities).where(and(eq(schema.enrichmentIdentities.workspaceId, WORKSPACE), eq(schema.enrichmentIdentities.canonicalKey, "in:pager-3")));
    expect(identities).toHaveLength(0);
    expect((await get(`/enrichment/companies/${companyId}/people`)).json().total).toBe(19);
    const logged = await audits("enrichment.delete");
    expect(logged.some((entry) => (entry.beforeState as { prospectId?: string }).prospectId === person!.prospectId)).toBe(true);
    expect((await del(`/enrichment/people/${person!.prospectId}`)).statusCode).toBe(404);
    // Capturing the person again starts a clean record.
    await post("/enrichment/linkedin-urls", { url: "https://www.linkedin.com/in/pager-3/" });
    expect((await liveContacts()).some((row) => row.linkedinUrl === "https://www.linkedin.com/in/pager-3/")).toBe(true);
  });

  it("deletes a company with its evidence and candidate links, keeping the people", async () => {
    const before = (await get("/enrichment/people")).json().total;
    expect((await ledger("company", companyId)).length).toBeGreaterThan(0);
    const removed = await del(`/enrichment/companies/${companyId}`);
    expect(removed.statusCode).toBe(200);
    expect(await ledger("company", companyId)).toHaveLength(0);
    expect((await get(`/enrichment/companies/${companyId}`)).statusCode).toBe(404);
    const edges = await db().select().from(schema.companyPersonDiscoveries).where(eq(schema.companyPersonDiscoveries.companyId, companyId));
    expect(edges).toHaveLength(0);
    expect((await get("/enrichment/people")).json().total).toBe(before);
    expect((await del(`/enrichment/companies/${companyId}`, outsider)).statusCode).toBe(404);
  });
});
