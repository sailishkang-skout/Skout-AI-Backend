/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-05 test fixtures set contact emails directly.
 *   - Tables touched directly: contacts (owned by apps/crm) — updated as a fixture
 *   - Owning service: apps/crm (test fixtures require direct access for setup)
 *   - Reason: integration tests need people with and without a verified email.
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildTestAuth, buildTestAuthEnv, grantSystemMemberRole } from "@skout/auth";
import { loadEnv, type Env } from "../config/env.js";
import { buildApp } from "../app.js";
import { addSuppression, isSuppressed } from "../services/suppression.service.js";
import { audienceMembers, saveAudience, previewAudience } from "../services/enrichment/audience.service.js";
import {
  campaignSendGate,
  createCampaign,
  getCampaign,
  launchCampaign,
  recordCampaignOutcome,
  reviewCampaign,
  sandboxPolicy,
  setRecipientDecision,
  submitCampaign,
  updateDraft,
} from "../services/enrichment/campaign.service.js";
import { claimsInCopy, defaultDraft, OPENING_TOKEN, type Claim, type RecipientClaims } from "../services/enrichment/campaign-composer.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const RUN = randomUUID().slice(0, 6);
let app: FastifyInstance;
let config: Env;
let owner: Record<string, string>;
let ownerId: string;
/** Approves campaigns: a second person, since the creator and submitter may not approve their own. */
let reviewerId: string;
let outsider: Record<string, string>;

const {
  aiDrafts,
  auditLogs,
  contacts,
  emailVerifications,
  enrichmentCampaignRecipients,
  enrichmentCampaignReviews,
  enrichmentCampaigns,
  evidenceLedger,
  listMembers,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
} = schema;

async function provisionUser(workspaceId: string) {
  const db = app.db!;
  const userId = randomUUID();
  const email = `campaign-test-${userId}@example.com`;
  await db.insert(schema.users).values({ id: userId, email, fullName: "Campaign Test User", status: "active" });
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId, role: "owner" });
  if (!(await grantSystemMemberRole(db, workspaceId, userId, "owner"))) throw new Error("System roles are not seeded");
  const auth = buildTestAuth({ workspaceId, userId, email, role: "owner" });
  return { userId, headers: { "x-workspace-id": workspaceId, "content-type": "application/json", Authorization: auth.bearer } };
}

beforeAll(async () => {
  config = { ...loadEnv(), LOG_LEVEL: "fatal" as const, ...buildTestAuthEnv(), CONSENT_ENFORCEMENT_ENABLED: false, ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS: "@sandbox.example" };
  // No external verification or eligibility service: tests never call one.
  for (const key of ["EMAIL_INTEL_SERVICE_URL", "HUNTER_API_KEY", "MILLIONVERIFIER_API_KEY", "ZEROBOUNCE_API_KEY", "NEVERBOUNCE_API_KEY"] as const) {
    config = { ...config, [key]: undefined };
  }
  app = await buildApp(config);
  const db = app.db;
  if (!db) throw new Error("database_unavailable");
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.insert(schema.workspaces).values({ id, name: "Campaign test", slug: `campaign-test-${id}` });
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
  reviewerId = (await provisionUser(WORKSPACE)).userId;
  outsider = (await provisionUser(OTHER_WORKSPACE)).headers;

  await post("/enrichment/ingest/company", {
    publicId: `initech-${RUN}`,
    sourceUrl: `https://www.linkedin.com/company/initech-${RUN}/about/`,
    name: `Initech ${RUN}`,
    website: `https://www.initech-${RUN}.example`,
    industry: "Software Development",
    size: "201-500 employees",
    specialties: ["Revenue Operations", "Analytics"],
  });
}, 60000);

afterAll(async () => {
  await app?.close();
});

const db = () => app.db!;
const actor = () => ({ workspaceId: WORKSPACE, userId: ownerId });
const reviewerActor = () => ({ workspaceId: WORKSPACE, userId: reviewerId });
const post = (url: string, payload: unknown = {}, headers: Record<string, string> = owner) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as object });
const get = (url: string, headers = owner) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });

interface PersonOptions {
  title?: string;
  location?: string;
  /** null = no email on record. */
  email?: string | null;
  verified?: boolean;
}

/** A person captured from their own profile at the saved company: verified employment. */
async function capturedPerson(slug: string, options: PersonOptions = {}): Promise<string> {
  const title = options.title ?? "Head of Revenue";
  const res = await post("/enrichment/ingest/person", {
    publicId: `${slug}-${RUN}`,
    sourceUrl: `https://www.linkedin.com/in/${slug}-${RUN}/`,
    fullName: `${slug[0]!.toUpperCase()}${slug.slice(1)} ${RUN}`,
    headline: `${title} at Initech ${RUN}`,
    locationName: options.location ?? "Pune, India",
    currentCompanyPublicId: `initech-${RUN}`,
    currentCompanies: [{ name: `Initech ${RUN}`, title, companyPublicId: `initech-${RUN}` }],
  });
  expect(res.statusCode, res.body).toBe(201);
  const prospectId = res.json().person.prospectId as string;
  const email = options.email === undefined ? `${slug}-${RUN}@sandbox.example` : options.email;
  if (email) {
    await db().update(contacts).set({ email }).where(and(eq(contacts.workspaceId, WORKSPACE), eq(contacts.sourceProspectId, prospectId)));
    if (options.verified !== false) {
      await db().insert(emailVerifications).values({ workspaceId: WORKSPACE, prospectId, email, status: "valid", deliverabilityScore: 97, provider: "zerobounce" });
    }
  }
  return prospectId;
}

/** A person seen only on a Sales Navigator card: discovery evidence. */
async function discoveredPerson(slug: string): Promise<string> {
  const leadUrl = `https://www.linkedin.com/sales/lead/${slug}${RUN},NAME_SEARCH,x`;
  const fullName = `Lead ${slug} ${RUN}`;
  await post("/enrichment/ingest/sales-search", {
    sourceUrl: "https://www.linkedin.com/sales/search/people?query=(filters:List())",
    pagesRead: 1,
    peopleProfiles: [
      {
        publicId: `sales-lead:${slug}${RUN}`,
        sourceUrl: leadUrl,
        fullName,
        headline: `Sales Director at Initech ${RUN}`,
        currentCompanies: [{ name: `Initech ${RUN}`, title: "Sales Director" }],
        relationshipContext: { salesNavigatorLeadUrl: leadUrl },
      },
    ],
  });
  const found = (await get(`/enrichment/people?q=${encodeURIComponent(fullName)}`)).json().people[0];
  const email = `lead-${slug}-${RUN}@sandbox.example`;
  await db().update(contacts).set({ email }).where(and(eq(contacts.workspaceId, WORKSPACE), eq(contacts.sourceProspectId, found.prospectId)));
  await db().insert(emailVerifications).values({ workspaceId: WORKSPACE, prospectId: found.prospectId, email, status: "valid", deliverabilityScore: 97, provider: "zerobounce" });
  return found.prospectId;
}

const READY_STEPS = defaultDraft(false).steps.map((step) => ({ ...step, body: step.body.replace(/\[Write[^\]]*\]/, "We help revenue teams keep their pipeline data clean.") }));

async function campaignFor(prospectIds: string[], name = `Campaign ${randomUUID().slice(0, 6)}`) {
  return createCampaign(db(), config, actor(), { name, prospectIds });
}
/** Draft → submitted → approved, with real copy in place. */
async function approvedCampaign(prospectIds: string[]) {
  const campaign = await campaignFor(prospectIds);
  await updateDraft(db(), actor(), campaign.id, READY_STEPS);
  await submitCampaign(db(), config, actor(), campaign.id);
  await reviewCampaign(db(), config, reviewerActor(), campaign.id, { decision: "approved", comment: "Recipients and copy checked." });
  return campaign.id;
}
const detail = (id: string) => getCampaign(db(), config, WORKSPACE, id);
const enrollmentsFor = (prospectIds: string[]) =>
  db().select().from(sequenceEnrollments).where(and(eq(sequenceEnrollments.workspaceId, WORKSPACE), inArray(sequenceEnrollments.prospectId, prospectIds)));
const row = async (id: string) => (await db().select().from(enrichmentCampaigns).where(eq(enrichmentCampaigns.id, id)))[0]!;

describe("ENR-05 audiences", () => {
  it("segments by role, location, evidence state and freshness, with live counts", async () => {
    const vp = await capturedPerson("vera", { title: "VP Marketing", location: "Berlin, Germany" });
    await capturedPerson("omar", { title: "Engineer", location: "Berlin, Germany", email: null });
    const lead = await discoveredPerson("aud");

    const all = await previewAudience(db(), WORKSPACE, { q: RUN });
    expect(all.counts.total).toBeGreaterThanOrEqual(3);
    expect(all.counts.verifiedEmployment + all.counts.discoveryOnly).toBe(all.counts.total);
    expect(all.counts.fresh).toBe(all.counts.total);
    expect(all.counts.freshnessDays).toBe(90);

    const marketing = await previewAudience(db(), WORKSPACE, { q: RUN, role: "marketing", location: "berlin", evidenceState: "verified" });
    expect(marketing.sample.map((person) => person.prospectId)).toEqual([vp]);
    expect(marketing.counts).toMatchObject({ total: 1, verifiedEmployment: 1, discoveryOnly: 0, withEmail: 1, verifiedEmail: 1, suppressed: 0 });

    const discovery = await previewAudience(db(), WORKSPACE, { q: RUN, evidenceState: "discovery" });
    expect(discovery.sample.map((person) => person.prospectId)).toContain(lead);
    expect(discovery.sample.map((person) => person.prospectId)).not.toContain(vp);
    expect((await previewAudience(db(), WORKSPACE, { q: RUN, freshness: "stale" })).counts.total).toBe(0);
    expect((await previewAudience(db(), WORKSPACE, { q: RUN, industry: "software", minEmployees: 1 })).counts.total).toBe(0);

    const res = await post("/enrichment/audiences/preview", { filters: { q: RUN, role: "marketing" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.total).toBe(1);
    expect((await post("/enrichment/audiences/preview", { filters: { nope: true } })).statusCode).toBe(422);
  });

  it("leaves out a person who was added by URL and has not been captured yet", async () => {
    const before = (await previewAudience(db(), WORKSPACE, {})).counts.total;
    const added = await post("/enrichment/linkedin-urls", { url: `https://www.linkedin.com/in/pending-${RUN}/` });
    expect(added.statusCode).toBe(201);
    const pending = added.json().prospectId as string;

    const after = await previewAudience(db(), WORKSPACE, {});
    expect(after.counts.total).toBe(before);
    expect((await audienceMembers(db(), WORKSPACE, {})).map((person) => person.prospectId)).not.toContain(pending);
    // Still listed under People, where it can be captured.
    expect((await get(`/enrichment/people/${pending}`)).statusCode).toBe(200);
  });

  it("saves an audience into an ordinary list and keeps the list in step when it is saved again", async () => {
    const first = await capturedPerson("lina", { title: "Chief Listmaker" });
    const audience = await saveAudience(db(), actor(), { name: `Listmakers ${RUN}`, filters: { q: RUN, role: "listmaker" } });
    expect(audience.listId).toBeTruthy();
    const members = () => db().select().from(listMembers).where(eq(listMembers.listId, audience.listId!));
    expect((await members()).map((member) => member.prospectId)).toEqual([first]);

    const second = await capturedPerson("lars", { title: "Deputy Listmaker" });
    const again = await saveAudience(db(), actor(), { id: audience.id, name: `Listmakers ${RUN}`, filters: { q: RUN, role: "deputy listmaker" } });
    expect(again.listId).toBe(audience.listId);
    expect((await members()).map((member) => member.prospectId)).toEqual([second]);

    await expect(saveAudience(db(), actor(), { name: "Nobody", filters: { q: `nobody-${randomUUID()}` } })).rejects.toMatchObject({ code: "audience_empty" });
    expect((await get(`/enrichment/audiences/${audience.id}`, outsider)).statusCode).toBe(404);
    expect((await get("/enrichment/audiences", outsider)).json().audiences).toEqual([]);
  });
});

describe("ENR-05 composer", () => {
  it("gives every claim in a draft an evidence reference with source, capture time and confidence", async () => {
    const verified = await capturedPerson("priya");
    const lead = await discoveredPerson("comp");
    const campaign = await campaignFor([verified, lead]);
    const view = await detail(campaign.id);
    expect(view.recipients).toHaveLength(2);

    const ledgerIds = new Set((await db().select({ id: evidenceLedger.id }).from(evidenceLedger).where(eq(evidenceLedger.workspaceId, WORKSPACE))).map((entry) => entry.id));
    const everyClaim: Claim[] = [];
    for (const recipient of view.recipients) {
      const claims = recipient.claims as RecipientClaims;
      everyClaim.push(...(claims.reason ? [claims.reason] : []), ...claims.talkingPoints, ...claims.flagged);
      // Whatever is placed in copy is a usable claim.
      for (const claim of claimsInCopy(claims)) expect(claim.usable).toBe(true);
    }
    expect(everyClaim.length).toBeGreaterThan(0);
    for (const claim of everyClaim) {
      expect(ledgerIds.has(claim.evidenceId), `claim "${claim.text}" has no evidence row`).toBe(true);
      expect(claim.source).toBeTruthy();
      expect(Number.isNaN(Date.parse(claim.capturedAt))).toBe(false);
      expect(claim.confidence).toBeGreaterThan(0);
      expect(["verified", "discovery", "unverified"]).toContain(claim.state);
    }

    const person = view.recipients.find((recipient) => recipient.prospectId === verified)!;
    const claims = person.claims as RecipientClaims;
    expect(claims.reason).toMatchObject({ kind: "role", attribute: "employment", state: "verified", usable: true, source: "linkedin_public_profile" });
    expect(claims.reason!.text).toBe(`I saw that you're Head of Revenue at Initech ${RUN}.`);
    expect(claims.talkingPoints[0]).toMatchObject({ kind: "company", attribute: "industry", source: "linkedin_company_page" });
    expect(claims.opening).toBe(`${claims.reason!.text} Initech ${RUN} is listed under Software Development.`);
  });

  it("flags discovery-only evidence and keeps it out of the copy", async () => {
    const lead = await discoveredPerson("flag");
    const campaign = await campaignFor([lead]);
    const [recipient] = (await detail(campaign.id)).recipients;
    const claims = recipient!.claims as RecipientClaims;
    expect(claims.reason).toBeNull();
    expect(claims.talkingPoints).toEqual([]);
    expect(claims.opening).toBe("");
    expect(claims.flagged[0]).toMatchObject({ attribute: "employment", state: "discovery", usable: false, excludedReason: "discovery_only" });
    expect((await detail(campaign.id)).counts.withoutTalkingPoint).toBe(1);
  });

  it("blocks submission while the copy still has placeholder text", async () => {
    const campaign = await campaignFor([await capturedPerson("pla")]);
    expect((await detail(campaign.id)).problems.join(" ")).toMatch(/placeholder text/);
    await expect(submitCampaign(db(), config, actor(), campaign.id)).rejects.toMatchObject({ code: "draft_incomplete" });
    const edited = await updateDraft(db(), actor(), campaign.id, [...READY_STEPS.slice(0, 1), { ...READY_STEPS[1]!, body: `Following up. ${OPENING_TOKEN}` }]);
    expect(edited.problems.join(" ")).toMatch(/only step 1 may/);
  });
});

describe("ENR-05 recipients and compliance", () => {
  it("shows why each excluded recipient is excluded and refuses to include them", async () => {
    const ok = await capturedPerson("ella");
    const noEmail = await capturedPerson("nora", { email: null });
    const unverified = await capturedPerson("uma", { verified: false });
    const suppressed = await capturedPerson("sam");
    await addSuppression(db(), WORKSPACE, `sam-${RUN}@sandbox.example`, "unsubscribed");

    const campaign = await campaignFor([ok, noEmail, unverified, suppressed]);
    const view = await detail(campaign.id);
    const by = Object.fromEntries(view.recipients.map((recipient) => [recipient.prospectId, recipient]));
    expect(by[ok]).toMatchObject({ eligibility: "eligible", exclusionReason: null, emailVerification: "valid", consentStatus: "missing", suppressed: false });
    expect(by[noEmail]).toMatchObject({ eligibility: "excluded", exclusionReason: "no_email", exclusionMessage: "No email address on record" });
    expect(by[unverified]).toMatchObject({ eligibility: "excluded", exclusionReason: "email_not_verified", emailVerification: "unverified" });
    expect(by[suppressed]).toMatchObject({ eligibility: "excluded", exclusionReason: "suppressed", suppressed: true });
    expect(by[suppressed]!.exclusionMessage).toMatch(/suppression list/);
    expect(view.counts).toMatchObject({ total: 4, eligible: 1, excluded: 3, included: 1 });

    await expect(setRecipientDecision(db(), actor(), campaign.id, suppressed, { decision: "included" })).rejects.toMatchObject({ code: "recipient_excluded" });
    const removed = await setRecipientDecision(db(), actor(), campaign.id, ok, { decision: "removed", comment: "Existing customer" });
    expect(removed).toMatchObject({ decision: "removed", decisionComment: "Existing customer" });
    await updateDraft(db(), actor(), campaign.id, READY_STEPS);
    await expect(submitCampaign(db(), config, actor(), campaign.id)).rejects.toMatchObject({ code: "no_eligible_recipients" });
  });

  it("requires a lawful basis for recipients without consent when consent is enforced", async () => {
    const enforced = { ...config, CONSENT_ENFORCEMENT_ENABLED: true };
    const prospectId = await capturedPerson("cora");
    const campaign = await campaignFor([prospectId]);
    await updateDraft(db(), actor(), campaign.id, READY_STEPS);
    await submitCampaign(db(), enforced, actor(), campaign.id);
    await expect(reviewCampaign(db(), enforced, reviewerActor(), campaign.id, { decision: "approved" })).rejects.toMatchObject({ code: "consent_basis_required" });
    const approved = await reviewCampaign(db(), enforced, reviewerActor(), campaign.id, { decision: "approved", consentBasis: "legitimate_interest" });
    expect(approved.campaign).toMatchObject({ status: "approved", consentBasis: "legitimate_interest" });

    await launchCampaign(db(), enforced, actor(), campaign.id);
    const consent = await db().select().from(schema.consents).where(and(eq(schema.consents.workspaceId, WORKSPACE), eq(schema.consents.subjectId, prospectId)));
    expect(consent[0]).toMatchObject({ type: "email", basis: "legitimate_interest", recordedBy: reviewerId }); // the approver stated the basis
  });
});

describe("ENR-05 approval", () => {
  it("does not enroll or send anything without a recorded approval", async () => {
    const prospectId = await capturedPerson("anna");
    const campaign = await campaignFor([prospectId]);
    const before = await detail(campaign.id);
    expect(before.sendEnabled).toBe(false);

    for (const step of ["draft", "submitted"]) {
      const res = await post(`/enrichment/campaigns/${campaign.id}/launch`);
      expect(res.statusCode, step).toBe(409);
      expect(res.json().code).toBe("approval_required");
      if (step === "draft") {
        await updateDraft(db(), actor(), campaign.id, READY_STEPS);
        await submitCampaign(db(), config, actor(), campaign.id);
      }
    }
    expect(await enrollmentsFor([prospectId])).toEqual([]);
    expect(await db().select().from(aiDrafts).where(and(eq(aiDrafts.workspaceId, WORKSPACE), eq(aiDrafts.prospectId, prospectId)))).toEqual([]);
    expect((await row(campaign.id)).sequenceId).toBeNull();

    // A rejection needs a comment, is recorded, and still allows no send.
    await expect(reviewCampaign(db(), config, actor(), campaign.id, { decision: "rejected" })).rejects.toMatchObject({ code: "comment_required" });
    const rejected = await reviewCampaign(db(), config, actor(), campaign.id, { decision: "rejected", comment: "Tone is too pushy." });
    expect(rejected.campaign).toMatchObject({ status: "rejected", reviewComment: "Tone is too pushy." });
    expect(rejected.reviews[0]).toMatchObject({ decision: "rejected", comment: "Tone is too pushy.", reviewerId: ownerId });
    await expect(launchCampaign(db(), config, actor(), campaign.id)).rejects.toMatchObject({ code: "approval_required" });
    expect(await enrollmentsFor([prospectId])).toEqual([]);
  });

  it("launches an approved campaign through the sequence path and never enrolls suppressed or unverified people", async () => {
    const ok = await capturedPerson("gina");
    const unverified = await capturedPerson("hugo", { verified: false });
    const lateSuppressed = await capturedPerson("iris");
    const id = await approvedCampaign([ok, unverified, lateSuppressed]);
    const approved = await detail(id);
    expect(approved.sendEnabled).toBe(true);
    expect(approved.campaign.approvedBy).toBe(reviewerId);
    expect(approved.reviews[0]).toMatchObject({ decision: "approved", recipientCount: 2 });

    // Suppressed after approval, before launch: left out at launch.
    await addSuppression(db(), WORKSPACE, `iris-${RUN}@sandbox.example`, "manual");
    const res = await post(`/enrichment/campaigns/${id}/launch`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().enrolled).toBe(1);
    expect(res.json().skipped).toEqual(
      expect.arrayContaining([
        { prospectId: lateSuppressed, reason: "suppressed" },
        { prospectId: unverified, reason: "email_not_verified" },
      ])
    );
    expect(res.json().campaign.status).toBe("launched");

    const enrollments = await enrollmentsFor([ok, unverified, lateSuppressed]);
    expect(enrollments.map((enrollment) => enrollment.prospectId)).toEqual([ok]);
    const campaign = await row(id);
    const [sequence] = await db().select().from(sequences).where(eq(sequences.id, campaign.sequenceId!));
    expect(sequence).toMatchObject({ status: "active", workspaceId: WORKSPACE });
    const steps = await db().select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequence!.id));
    expect(steps).toHaveLength(3);
    expect(steps.every((step) => step.stepType === "email")).toBe(true);
    // The shared template carries no claim; the recipient's approved draft does.
    expect(steps.some((step) => (step.bodyTemplate ?? "").includes("I saw that"))).toBe(false);
    expect(steps.some((step) => (step.bodyTemplate ?? "").includes(OPENING_TOKEN))).toBe(false);
    const drafts = await db().select().from(aiDrafts).where(and(eq(aiDrafts.workspaceId, WORKSPACE), eq(aiDrafts.prospectId, ok)));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "approved", reviewedBy: reviewerId });
    expect(drafts[0]!.enrollmentStepId).toBeTruthy();
    expect(drafts[0]!.body).toContain(`I saw that you're Head of Revenue at Initech ${RUN}.`);

    const audit = (await db().select().from(auditLogs).where(and(eq(auditLogs.workspaceId, WORKSPACE), eq(auditLogs.entityId, id)))).map((entry) => entry.action);
    expect(audit).toEqual(expect.arrayContaining(["enrichment.campaign.create", "enrichment.campaign.submit", "enrichment.campaign.approve", "enrichment.campaign.launch"]));
    // Launching twice does nothing more.
    await expect(launchCampaign(db(), config, actor(), id)).rejects.toMatchObject({ code: "approval_required" });
    expect(await enrollmentsFor([ok])).toHaveLength(1);
  });

  it("forces re-review when evidence changes after approval", async () => {
    const prospectId = await capturedPerson("jane");
    const id = await approvedCampaign([prospectId]);
    // The person's role changes after approval.
    await post("/enrichment/ingest/person", {
      publicId: `jane-${RUN}`,
      sourceUrl: `https://www.linkedin.com/in/jane-${RUN}/`,
      fullName: `Jane ${RUN}`,
      headline: `Chief Revenue Officer at Initech ${RUN}`,
      currentCompanyPublicId: `initech-${RUN}`,
      currentCompanies: [{ name: `Initech ${RUN}`, title: "Chief Revenue Officer", companyPublicId: `initech-${RUN}` }],
    });
    await expect(launchCampaign(db(), config, actor(), id)).rejects.toMatchObject({ code: "re_review_required", statusCode: 409 });
    expect(await enrollmentsFor([prospectId])).toEqual([]);

    const after = await detail(id);
    expect(after.campaign).toMatchObject({ status: "changes_required", approvedAt: null, approvedBy: null });
    expect(after.sendEnabled).toBe(false);
    expect(after.reviews[0]).toMatchObject({ decision: "invalidated" });
    expect((after.recipients[0]!.claims as RecipientClaims).reason!.text).toContain("Chief Revenue Officer");

    // Reviewed again, it can go out with the new claim.
    await submitCampaign(db(), config, actor(), id);
    await reviewCampaign(db(), config, reviewerActor(), id, { decision: "approved" });
    expect((await launchCampaign(db(), config, actor(), id)).enrolled).toBe(1);
  });

  it("withdraws an approval when the copy or the recipients are edited", async () => {
    const [a, b] = [await capturedPerson("kate"), await capturedPerson("kyle")];
    const id = await approvedCampaign([a, b]);
    await updateDraft(db(), actor(), id, READY_STEPS.map((step) => ({ ...step, subject: `${step.subject}!` })));
    expect((await detail(id)).campaign.status).toBe("changes_required");
    await expect(launchCampaign(db(), config, actor(), id)).rejects.toMatchObject({ code: "approval_required" });

    await submitCampaign(db(), config, actor(), id);
    await reviewCampaign(db(), config, reviewerActor(), id, { decision: "approved" });
    await setRecipientDecision(db(), actor(), id, b, { decision: "removed" });
    expect((await detail(id)).campaign.status).toBe("changes_required");
    const reviews = await db().select().from(enrichmentCampaignReviews).where(eq(enrichmentCampaignReviews.campaignId, id));
    expect(reviews.filter((review) => review.decision === "invalidated")).toHaveLength(2);
    expect(await enrollmentsFor([a, b])).toEqual([]);
  });

  it("keeps campaigns inside their workspace", async () => {
    const campaign = await campaignFor([await capturedPerson("zoe")]);
    expect((await get(`/enrichment/campaigns/${campaign.id}`, outsider)).statusCode).toBe(404);
    expect((await post(`/enrichment/campaigns/${campaign.id}/launch`, {}, outsider)).statusCode).toBe(404);
    expect((await get("/enrichment/campaigns", outsider)).json().total).toBe(0);
    expect((await get("/enrichment/campaigns/not-a-uuid")).statusCode).toBe(404);
    const created = await post("/enrichment/campaigns", { name: "Both", audienceId: randomUUID(), prospectIds: ["x"] });
    expect(created.statusCode).toBe(422);
  });
});

describe("ENR-05 send gate", () => {
  async function launched(slug: string, email?: string) {
    const prospectId = await capturedPerson(slug, { email });
    const id = await approvedCampaign([prospectId]);
    const { newEnrollments } = await launchCampaign(db(), config, actor(), id);
    return { id, prospectId, enrollmentId: newEnrollments[0]!.enrollmentId, email: email ?? `${slug}-${RUN}@sandbox.example` };
  }

  it("lets a non-campaign enrollment through untouched", async () => {
    expect(await campaignSendGate(db(), config, WORKSPACE, randomUUID(), "anyone@elsewhere.example")).toEqual({ allowed: true });
  });

  it("outside production, sends only to sandbox recipients", async () => {
    const inside = await launched("mia");
    expect(await campaignSendGate(db(), config, WORKSPACE, inside.enrollmentId, inside.email)).toEqual({ allowed: true });

    const real = await launched("noah", `noah-${RUN}@real-customer.example`);
    expect(await campaignSendGate(db(), config, WORKSPACE, real.enrollmentId, real.email)).toEqual({ allowed: false, reason: "sandbox_recipient_blocked", retry: false });
    // With no allow-list configured, nothing is sent outside production.
    expect(await campaignSendGate(db(), { ...config, ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS: undefined }, WORKSPACE, inside.enrollmentId, inside.email)).toMatchObject({ allowed: false, reason: "sandbox_recipient_blocked" });
    expect(await campaignSendGate(db(), { ...config, NODE_ENV: "production" }, WORKSPACE, real.enrollmentId, real.email)).toEqual({ allowed: true });

    expect(sandboxPolicy({ NODE_ENV: "development", ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS: "qa@skout.example, @sandbox.example" }).allows("QA@skout.example")).toBe(true);
    expect(sandboxPolicy({ NODE_ENV: "development", ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS: "" }).allows("qa@skout.example")).toBe(false);
    expect((await detail(inside.id)).sandbox).toEqual({ active: true, allowedRecipients: ["@sandbox.example"] });
  });

  it("holds the send when the approval no longer stands", async () => {
    const sent = await launched("olga");
    await db().update(enrichmentCampaigns).set({ status: "changes_required", approvedAt: null, approvedBy: null }).where(eq(enrichmentCampaigns.id, sent.id));
    expect(await campaignSendGate(db(), config, WORKSPACE, sent.enrollmentId, sent.email)).toEqual({ allowed: false, reason: "campaign_approval_required", retry: true });
  });

  it("holds the first email and withdraws the approval when evidence changed after launch", async () => {
    const target = await launched("pete");
    await post("/enrichment/ingest/person", {
      publicId: `pete-${RUN}`,
      sourceUrl: `https://www.linkedin.com/in/pete-${RUN}/`,
      fullName: `Pete ${RUN}`,
      headline: `Advisor at Initech ${RUN}`,
      currentCompanyPublicId: `initech-${RUN}`,
      currentCompanies: [{ name: `Initech ${RUN}`, title: "Advisor", companyPublicId: `initech-${RUN}` }],
    });
    expect(await campaignSendGate(db(), config, WORKSPACE, target.enrollmentId, target.email)).toEqual({ allowed: false, reason: "campaign_re_review_required", retry: true });
    expect((await row(target.id)).status).toBe("changes_required");
  });

  it("refuses an address that is no longer the approved, verified one", async () => {
    const target = await launched("quin");
    expect(await campaignSendGate(db(), config, WORKSPACE, target.enrollmentId, `other-${RUN}@sandbox.example`)).toMatchObject({ allowed: false, reason: "campaign_recipient_email_changed" });
    await db().update(emailVerifications).set({ status: "invalid" }).where(and(eq(emailVerifications.workspaceId, WORKSPACE), eq(emailVerifications.prospectId, target.prospectId)));
    expect(await campaignSendGate(db(), config, WORKSPACE, target.enrollmentId, target.email)).toMatchObject({ allowed: false, reason: "email_not_verified" });
  });
});

describe("ENR-05 outcomes", () => {
  it("records sent, replied and bounced, suppresses a hard bounce, and counts toward the audience", async () => {
    const [replier, bouncer] = [await capturedPerson("rosa", { title: "Outcome Lead" }), await capturedPerson("rudy", { title: "Outcome Lead" })];
    const audience = await saveAudience(db(), actor(), { name: `Outcomes ${RUN}`, filters: { q: RUN, role: "outcome lead" } });
    const campaign = await createCampaign(db(), config, actor(), { name: `Outcomes ${RUN}`, audienceId: audience.id });
    await updateDraft(db(), actor(), campaign.id, READY_STEPS);
    await submitCampaign(db(), config, actor(), campaign.id);
    await reviewCampaign(db(), config, reviewerActor(), campaign.id, { decision: "approved" });
    const { newEnrollments } = await launchCampaign(db(), config, actor(), campaign.id);
    const enrollment = Object.fromEntries(newEnrollments.map((entry) => [entry.prospectId, entry.enrollmentId]));

    for (const prospectId of [replier, bouncer]) await recordCampaignOutcome(db(), WORKSPACE, enrollment[prospectId]!, "sent");
    await recordCampaignOutcome(db(), WORKSPACE, enrollment[replier]!, "replied");
    await recordCampaignOutcome(db(), WORKSPACE, enrollment[bouncer]!, "bounced");
    // Reported twice by a retried job: counted once.
    await recordCampaignOutcome(db(), WORKSPACE, enrollment[bouncer]!, "bounced");
    // Not a campaign enrollment: nothing happens.
    await recordCampaignOutcome(db(), WORKSPACE, randomUUID(), "bounced");

    const bouncedEmail = `rudy-${RUN}@sandbox.example`;
    expect(await isSuppressed(db(), WORKSPACE, bouncedEmail)).toBe(true);
    const [verdict] = await db().select().from(emailVerifications).where(and(eq(emailVerifications.workspaceId, WORKSPACE), eq(emailVerifications.prospectId, bouncer)));
    expect(verdict).toMatchObject({ status: "invalid", provider: "sequence_bounce" });
    const deliverability = await db()
      .select()
      .from(evidenceLedger)
      .where(and(eq(evidenceLedger.workspaceId, WORKSPACE), eq(evidenceLedger.entityId, bouncer), eq(evidenceLedger.attribute, "email_deliverability")));
    expect(deliverability[0]).toMatchObject({ source: "skout_sequence", method: "hard_bounce" });

    // An unsubscribe arrives as a suppression row and is picked up when the campaign is read.
    await addSuppression(db(), WORKSPACE, `rosa-${RUN}@sandbox.example`, "unsubscribed");
    const view = await detail(campaign.id);
    expect(view.outcomes).toEqual({ enrolled: 2, sent: 2, replied: 1, bounced: 1, unsubscribed: 1 });
    const res = await get(`/enrichment/audiences/${audience.id}`);
    expect(res.json().audience.stats.outcomes).toEqual({ sent: 2, replied: 1, bounced: 1, unsubscribed: 1 });

    // The bounced address cannot be enrolled again.
    const next = await campaignFor([bouncer]);
    expect((await detail(next.id)).recipients[0]).toMatchObject({ eligibility: "excluded", exclusionReason: "email_not_verified" });
  });
});

describe("ENR-05 job changes", () => {
  it("turns a job change into a review item, not a message", async () => {
    const prospectId = await capturedPerson("tess");
    const res = await post("/enrichment/ingest/person", {
      publicId: `tess-${RUN}`,
      sourceUrl: `https://www.linkedin.com/in/tess-${RUN}/`,
      fullName: `Tess ${RUN}`,
      headline: `VP Sales at Initech ${RUN}`,
      currentCompanyPublicId: `initech-${RUN}`,
      currentCompanies: [{ name: `Initech ${RUN}`, title: "VP Sales", companyPublicId: `initech-${RUN}` }],
    });
    expect(res.statusCode).toBe(201);

    const queue = (await get("/enrichment/campaigns/review-queue")).json();
    const item = queue.items.find((entry: any) => entry.recipient?.prospectId === prospectId);
    expect(item, "the job change is in the review queue").toBeTruthy();
    expect(item.campaign).toMatchObject({ trigger: "job_change", status: "draft", approvedAt: null, sequenceId: null, name: `Job change: Tess ${RUN}` });
    expect(item.claimsInCopy[0]).toMatchObject({ kind: "job_change", attribute: "employment", usable: true });
    expect(item.claimsInCopy[0].text).toBe(`I saw that you recently moved into the VP Sales role at Initech ${RUN}.`);
    expect(item.claimsInCopy[0].evidenceId).toBeTruthy();

    // Nothing was enrolled, drafted for sending, or sent.
    expect(await enrollmentsFor([prospectId])).toEqual([]);
    expect(await db().select().from(aiDrafts).where(and(eq(aiDrafts.workspaceId, WORKSPACE), eq(aiDrafts.prospectId, prospectId)))).toEqual([]);
    const view = await detail(item.campaign.id);
    expect(view.sendEnabled).toBe(false);
    await expect(launchCampaign(db(), config, actor(), item.campaign.id)).rejects.toMatchObject({ code: "approval_required" });

    // One suggestion per change, however often the queue is read.
    await get("/enrichment/campaigns/review-queue");
    const suggestions = await db().select().from(enrichmentCampaigns).where(and(eq(enrichmentCampaigns.workspaceId, WORKSPACE), eq(enrichmentCampaigns.trigger, "job_change")));
    const forTess = await db().select().from(enrichmentCampaignRecipients).where(and(eq(enrichmentCampaignRecipients.prospectId, prospectId), inArray(enrichmentCampaignRecipients.campaignId, suggestions.map((entry) => entry.id))));
    expect(forTess).toHaveLength(1);

    // Dismissing takes it out of the queue.
    const dismissed = await post(`/enrichment/campaigns/${item.campaign.id}/dismiss`, { comment: "Not a fit" });
    expect(dismissed.json().campaign.status).toBe("dismissed");
    const after = (await get("/enrichment/campaigns/review-queue")).json();
    expect(after.items.some((entry: any) => entry.campaign.id === item.campaign.id)).toBe(false);
  });
});
