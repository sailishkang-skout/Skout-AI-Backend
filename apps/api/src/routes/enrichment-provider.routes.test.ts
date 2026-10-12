/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-04 test fixtures assert job → CRM state.
 *   - Tables touched directly: contacts (owned by apps/crm) — read, and updated as a fixture
 *   - Owning service: apps/crm (test fixtures require direct access for setup and assertions)
 *   - Reason: integration tests prove a provider job never writes contact fields.
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
import { connectUnipileAccount } from "../services/enrichment/provider-connections.service.js";
import {
  backoffMs,
  createProviderJob,
  JOB_ERRORS,
  purgeExpiredProviderResponses,
  recoverProviderJobs,
  runProviderJob,
  type ProviderJobDeps,
} from "../services/enrichment/provider-jobs.service.js";
import { ProviderRequestError, type UnipileProfileRequest } from "../services/enrichment/unipile-profile.adapter.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
let app: FastifyInstance;
let config: Env;
let owner: Record<string, string>;
let ownerId: string;
let member: Record<string, string>;
let outsider: Record<string, string>;

const { enrichmentJobs, enrichmentAttempts, enrichmentResults, enrichmentProviderConnections, evidenceLedger, contacts, auditLogs } = schema;

async function provisionUser(workspaceId: string, role: "owner" | "member") {
  const db = app.db!;
  const userId = randomUUID();
  const email = `provider-test-${userId}@example.com`;
  await db.insert(schema.users).values({ id: userId, email, fullName: "Provider Test User", status: "active" });
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId, role });
  if (!(await grantSystemMemberRole(db, workspaceId, userId, role))) throw new Error("System roles are not seeded");
  const auth = buildTestAuth({ workspaceId, userId, email, role });
  return { userId, headers: { "x-workspace-id": workspaceId, "content-type": "application/json", Authorization: auth.bearer } };
}

beforeAll(async () => {
  config = { ...loadEnv(), LOG_LEVEL: "fatal" as const, ...buildTestAuthEnv(), LINKEDIN_ENRICHMENT_TEST_MODE: false, UNIPILE_API_KEY: "platform-unipile-key", UNIPILE_DSN: "https://unipile.invalid" };
  // No verification service: the tests must not depend on, or call, a real one.
  for (const key of ["EMAIL_INTEL_SERVICE_URL", "HUNTER_API_KEY", "MILLIONVERIFIER_API_KEY", "ZEROBOUNCE_API_KEY", "NEVERBOUNCE_API_KEY"] as const) {
    config = { ...config, [key]: undefined };
  }
  app = await buildApp(config);
  const db = app.db;
  if (!db) throw new Error("database_unavailable");
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.insert(schema.workspaces).values({ id, name: "Provider test", slug: `provider-test-${id}` });
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
  const o = await provisionUser(WORKSPACE, "owner");
  owner = o.headers;
  ownerId = o.userId;
  member = (await provisionUser(WORKSPACE, "member")).headers;
  outsider = (await provisionUser(OTHER_WORKSPACE, "owner")).headers;
}, 60000);

afterAll(async () => {
  await app?.close();
});

const db = () => app.db!;
const post = (url: string, payload: unknown = {}, headers: Record<string, string> = owner) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as object });
const get = (url: string, headers = owner) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const del = (url: string, headers = owner) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });

const profileUrl = (id: string) => `https://www.linkedin.com/in/${id}/`;
const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** Legal has not approved the provider in code, so tests that reach it say so explicitly. */
const permitted: Partial<ProviderJobDeps> = { permission: () => ({ permitted: true, reason: null }) };
const neverCalled: ProviderJobDeps["fetchProfile"] = async () => {
  throw new Error("the provider must not be called in this test");
};

/** Through the service: the route allows 20 creates a minute, fewer than this file needs. */
async function createJob(url: string) {
  return createProviderJob(db(), { workspaceId: WORKSPACE, userId: ownerId }, { url });
}
async function createJobOverHttp(url: string, headers: Record<string, string> = owner) {
  const res = await post("/enrichment/provider-jobs", { url }, headers);
  expect(res.statusCode, res.body).toBe(202);
  return res.json() as { job: { id: string; status: string; targetId: string; correlationId: string }; reused: boolean };
}
const readJob = async (id: string) => (await get(`/enrichment/provider-jobs/${id}`)).json() as { job: Record<string, any>; attempts: Array<Record<string, any>> };
const jobRow = async (id: string) => (await db().select().from(enrichmentJobs).where(eq(enrichmentJobs.id, id)))[0]!;
const ledgerFor = (entityId: string) =>
  db().select().from(evidenceLedger).where(and(eq(evidenceLedger.workspaceId, WORKSPACE), eq(evidenceLedger.entityId, entityId)));

async function connect() {
  return connectUnipileAccount(
    db(),
    config,
    { workspaceId: WORKSPACE, userId: ownerId },
    { externalAccountId: "unipile-account-1" },
    { lister: async () => [{ id: "unipile-account-1", type: "LINKEDIN" }], permission: permitted.permission }
  );
}
const disconnectAll = () =>
  db().update(enrichmentProviderConnections).set({ status: "revoked" }).where(eq(enrichmentProviderConnections.workspaceId, WORKSPACE));

const PROVIDER_PAYLOAD = {
  object: "UserProfile",
  first_name: "Priya",
  last_name: "Raman",
  description: "Head of Revenue at Initech",
  emails: ["priya.raman@initech.example"],
  phone_numbers: ["+15550100"],
  specifics: { experience: [{ title: "Head of Revenue", company: { name: "Initech" } }] },
};
const respondWith = (payload: Record<string, unknown>, seen: UnipileProfileRequest[] = []): ProviderJobDeps["fetchProfile"] => async (request) => {
  seen.push(request);
  return { requestPath: "/v2/acc/users/x", status: 200, payload, payloadHash: "a".repeat(64), latencyMs: 12 };
};

describe("ENR-04 provider jobs", () => {
  it("queues a job for a LinkedIn URL and returns the unfinished job for the same URL instead of a second one", async () => {
    const url = profileUrl(unique("dedupe"));
    const first = await createJobOverHttp(url);
    expect(first.reused).toBe(false);
    expect(first.job.status).toBe("queued");
    expect(first.job.correlationId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await createJobOverHttp(`${url}?utm=1`);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);

    const audit = await db().select().from(auditLogs).where(and(eq(auditLogs.workspaceId, WORKSPACE), eq(auditLogs.entityId, first.job.id)));
    expect(audit.map((entry) => entry.action)).toEqual(["enrichment.enrich"]);
  });

  it("returns the first job when the same Idempotency-Key is sent again", async () => {
    const key = `idem-${randomUUID()}`;
    const headers = { ...owner, "idempotency-key": key };
    const first = await post("/enrichment/provider-jobs", { url: profileUrl(unique("idem")) }, headers);
    const again = await post("/enrichment/provider-jobs", { url: profileUrl(unique("idem-other")) }, headers);
    expect(again.json().reused).toBe(true);
    expect(again.json().job.id).toBe(first.json().job.id);
  });

  it("rejects anything that is not a LinkedIn profile or company URL", async () => {
    for (const url of ["https://example.com/in/someone/", "https://www.linkedin.com/sales/lead/ACwAAA,NAME_SEARCH,x", "https://www.linkedin.com/feed/"]) {
      const res = await post("/enrichment/provider-jobs", { url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code).toBe("invalid_linkedin_url");
    }
  });

  it("ends ACTION_REQUIRED with an actionable reason when no provider is connected", async () => {
    await disconnectAll();
    const { job } = await createJob(profileUrl(unique("no-connection")));
    const outcome = await runProviderJob(db(), config, job.id, { ...permitted, fetchProfile: neverCalled });
    expect(outcome).toEqual({ state: "terminal", status: "action_required" });

    const read = await readJob(job.id);
    expect(read.job).toMatchObject({ status: "action_required", terminal: true, errorCode: JOB_ERRORS.PROVIDER_CONNECTION_REQUIRED, attemptCount: 1 });
    expect(read.job.errorMessage).toMatch(/connect an authorised LinkedIn provider account/i);
    expect(read.job.completedAt).toBeTruthy();
  });

  it("does not call a provider Legal has not approved", async () => {
    const { job } = await createJob(profileUrl(unique("not-permitted")));
    const outcome = await runProviderJob(db(), config, job.id, { fetchProfile: neverCalled });
    expect(outcome).toEqual({ state: "terminal", status: "action_required" });
    expect((await readJob(job.id)).job.errorCode).toBe(JOB_ERRORS.PROVIDER_NOT_PERMITTED);
  });

  it("test mode records only the submitted URL: no provider call, no profile facts", async () => {
    const url = profileUrl(unique("test-mode"));
    const { job } = await createJob(url);
    const outcome = await runProviderJob(db(), { ...config, LINKEDIN_ENRICHMENT_TEST_MODE: true }, job.id, { fetchProfile: neverCalled });
    expect(outcome).toEqual({ state: "terminal", status: "partial" });

    const read = await readJob(job.id);
    expect(read.job).toMatchObject({ status: "partial", testMode: true, errorCode: null });
    expect(read.job.result).toMatchObject({ mode: "test", externalCallMade: false, submittedUrl: url });
    expect(read.attempts).toHaveLength(1);
    expect(read.attempts[0]).toMatchObject({ provider: "test_mode", operation: "record_submitted_url", hasRawResponse: false });

    // The only fact about this person is the URL a teammate submitted.
    const facts = await ledgerFor(job.targetId);
    expect(facts.map((fact) => fact.attribute)).toEqual(["linkedinUrl"]);
    const person = (await get(`/enrichment/people/${job.targetId}`)).json().person;
    expect(person.fullName ?? null).toBeNull();
    expect(person.headline ?? null).toBeNull();
  });

  it("test mode is ignored in production", async () => {
    await disconnectAll();
    const { job } = await createJob(profileUrl(unique("prod-test-mode")));
    await runProviderJob(db(), { ...config, NODE_ENV: "production", LINKEDIN_ENRICHMENT_TEST_MODE: true }, job.id, { ...permitted, fetchProfile: neverCalled });
    expect((await readJob(job.id)).job).toMatchObject({ status: "action_required", testMode: false });
  });

  it("keeps the raw provider response as evidence and promotes nothing from an unverified mapping", async () => {
    await connect();
    const publicId = unique("provider-ok");
    const { job } = await createJob(profileUrl(publicId));
    const seen: UnipileProfileRequest[] = [];
    const outcome = await runProviderJob(db(), config, job.id, { ...permitted, fetchProfile: respondWith(PROVIDER_PAYLOAD, seen) });
    expect(outcome).toEqual({ state: "terminal", status: "partial" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ accountId: "unipile-account-1", targetType: "person", identifier: publicId, apiKey: "platform-unipile-key" });

    const read = await readJob(job.id);
    expect(read.job.status).toBe("partial");
    expect(read.job.result.promoted).toEqual([]);
    expect(read.job.result.evidenceOnly.map((entry: { attribute: string }) => entry.attribute)).toEqual(
      expect.arrayContaining(["fullName", "headline", "emails", "phones", "experience"])
    );
    expect(read.job.result.message).toMatch(/not verified against a live provider payload/);
    // Neither the job nor its attempts carry the credential or the raw values.
    expect(JSON.stringify(read)).not.toContain("platform-unipile-key");
    expect(JSON.stringify(read)).not.toContain("priya.raman@initech.example");
    expect(read.attempts).toHaveLength(1);
    expect(read.attempts[0]).toMatchObject({ provider: "unipile", operation: "get_person_profile", status: "ok", hasRawResponse: true });

    const [attempt] = await db().select().from(enrichmentAttempts).where(eq(enrichmentAttempts.enrichmentJobId, job.id));
    expect(attempt!.responseOutput).toEqual(PROVIDER_PAYLOAD);
    expect(JSON.stringify(attempt!.requestInput)).not.toContain("platform-unipile-key");

    // No provider value reached the ledger or the CRM contact.
    expect((await ledgerFor(job.targetId)).map((fact) => fact.attribute)).toEqual(["linkedinUrl"]);
    const [contact] = await db().select().from(contacts).where(and(eq(contacts.workspaceId, WORKSPACE), eq(contacts.sourceProspectId, job.targetId)));
    expect(contact!.email).toBeNull();
    expect(contact!.phone).toBeNull();
    const contactData = (await get(`/enrichment/people/${job.targetId}/contact-data`)).json().contactData;
    expect(contactData.email).toBeNull();
    expect(contactData.phone).toBeNull();

    // The raw response is for administrators, and reading it is audited.
    const rawUrl = `/enrichment/provider-jobs/${job.id}/attempts/${read.attempts[0]!.id}/raw`;
    expect((await get(rawUrl, member)).statusCode).toBe(403);
    expect((await get(rawUrl, outsider)).statusCode).toBe(404);
    const raw = await get(rawUrl);
    expect(raw.statusCode).toBe(200);
    expect(raw.json().response).toEqual(PROVIDER_PAYLOAD);
    const reads = await db().select().from(auditLogs).where(and(eq(auditLogs.workspaceId, WORKSPACE), eq(auditLogs.action, "enrichment.provider_response.read")));
    expect(reads.some((entry) => entry.entityId === read.attempts[0]!.id)).toBe(true);
  });

  it("marks the second job for a URL as a re-enrich", async () => {
    await connect();
    const url = profileUrl(unique("re-enrich"));
    const first = await createJob(url);
    await runProviderJob(db(), config, first.job.id, { ...permitted, fetchProfile: respondWith(PROVIDER_PAYLOAD) });
    const second = await createJob(url);
    expect(second.reused).toBe(false);
    expect((await readJob(second.job.id)).job.trigger).toBe("re_enrich");
    const list = (await get(`/enrichment/provider-jobs?targetId=${first.job.targetId}`)).json();
    expect(list.total).toBe(2);
    expect(list.data[0].id).toBe(second.job.id);
  });

  it("retries a transient failure with backoff, a bounded number of times, then fails visibly", async () => {
    await connect();
    const { job } = await createJob(profileUrl(unique("retry")));
    let calls = 0;
    const down: ProviderJobDeps["fetchProfile"] = async () => {
      calls += 1;
      throw new ProviderRequestError("transient", "The provider returned 503.", 503);
    };
    let clock = new Date();
    const deps = { ...permitted, fetchProfile: down, now: () => clock };

    const first = await runProviderJob(db(), config, job.id, deps);
    expect(first.state).toBe("retry_scheduled");
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "queued", attemptCount: 1, errorCode: JOB_ERRORS.RETRY_SCHEDULED });
    expect(row.nextAttemptAt!.getTime() - clock.getTime()).toBe(backoffMs(1));
    expect((await readJob(job.id)).job.errorMessage).toMatch(/Attempt 1 of 3; trying again automatically/);

    // Not due yet: a worker that looks early leaves the job alone.
    expect(await runProviderJob(db(), config, job.id, deps)).toEqual({ state: "skipped" });
    expect(calls).toBe(1);

    clock = new Date(row.nextAttemptAt!.getTime() + 1);
    expect((await runProviderJob(db(), config, job.id, deps)).state).toBe("retry_scheduled");
    row = await jobRow(job.id);
    expect(row.nextAttemptAt!.getTime() - clock.getTime()).toBe(backoffMs(2));

    clock = new Date(row.nextAttemptAt!.getTime() + 1);
    expect(await runProviderJob(db(), config, job.id, deps)).toEqual({ state: "terminal", status: "failed" });
    const read = await readJob(job.id);
    expect(read.job).toMatchObject({ status: "failed", terminal: true, attemptCount: 3, errorCode: JOB_ERRORS.PROVIDER_REQUEST_FAILED });
    expect(read.attempts).toHaveLength(3);
    expect(read.attempts.every((attempt) => attempt.status === "error" && !attempt.hasRawResponse)).toBe(true);

    // Terminal means terminal: nothing runs it again.
    expect(await runProviderJob(db(), config, job.id, deps)).toEqual({ state: "skipped" });
    expect(calls).toBe(3);
  });

  it("waits at least as long as the provider's Retry-After", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(20)).toBe(15 * 60_000);
    expect(backoffMs(1, 120_000)).toBe(120_000);
  });

  it("does not retry a rejected credential or a missing profile", async () => {
    const connection = await connect();
    const rejected = await createJob(profileUrl(unique("rejected")));
    const reject: ProviderJobDeps["fetchProfile"] = async () => {
      throw new ProviderRequestError("credential_rejected", "The provider rejected the server-side credential.", 401);
    };
    expect(await runProviderJob(db(), config, rejected.job.id, { ...permitted, fetchProfile: reject })).toEqual({ state: "terminal", status: "action_required" });
    expect((await readJob(rejected.job.id)).job).toMatchObject({ errorCode: JOB_ERRORS.PROVIDER_CREDENTIAL_REJECTED, attemptCount: 1 });
    const providers = (await get("/enrichment/providers")).json();
    expect(providers.connections.find((entry: { id: string }) => entry.id === connection.id).lastErrorCode).toBe("provider_credential_rejected");

    const missing = await createJob(profileUrl(unique("missing")));
    const notFound: ProviderJobDeps["fetchProfile"] = async () => {
      throw new ProviderRequestError("not_found", "The provider has no profile for this LinkedIn URL.", 404);
    };
    expect(await runProviderJob(db(), config, missing.job.id, { ...permitted, fetchProfile: notFound })).toEqual({ state: "terminal", status: "failed" });
    expect((await readJob(missing.job.id)).job).toMatchObject({ errorCode: JOB_ERRORS.PROFILE_NOT_FOUND, attemptCount: 1 });
  });

  it("runs a job only once when two workers pick it up together", async () => {
    await connect();
    const { job } = await createJob(profileUrl(unique("race")));
    const seen: UnipileProfileRequest[] = [];
    const deps = { ...permitted, fetchProfile: respondWith(PROVIDER_PAYLOAD, seen) };
    const outcomes = await Promise.all([runProviderJob(db(), config, job.id, deps), runProviderJob(db(), config, job.id, deps)]);
    expect(outcomes.map((outcome) => outcome.state).sort()).toEqual(["skipped", "terminal"]);
    expect(seen).toHaveLength(1);
    expect((await jobRow(job.id)).attemptCount).toBe(1);
  });
});

describe("ENR-04 worker restart", () => {
  /** What the row looks like when the worker holding it has been killed. */
  async function killedMidJob(attemptCount: number, leaseExpiresAt: Date) {
    const { job } = await createJob(profileUrl(unique("killed")));
    await db()
      .update(enrichmentJobs)
      .set({ status: "running", attemptCount, startedAt: new Date(Date.now() - 600_000), leaseExpiresAt })
      .where(eq(enrichmentJobs.id, job.id));
    return job.id;
  }
  const past = () => new Date(Date.now() - 1_000);

  it("resumes a job whose worker was killed mid-run", async () => {
    await connect();
    const jobId = await killedMidJob(1, past());
    const recovery = await recoverProviderJobs(db());
    expect(recovery.due).toContain(jobId);
    expect(recovery.requeued).toBeGreaterThanOrEqual(1);
    expect((await readJob(jobId)).job).toMatchObject({ status: "queued", terminal: false, errorCode: JOB_ERRORS.WORKER_INTERRUPTED });

    const outcome = await runProviderJob(db(), config, jobId, { ...permitted, fetchProfile: respondWith(PROVIDER_PAYLOAD) });
    expect(outcome).toEqual({ state: "terminal", status: "partial" });
    expect((await readJob(jobId)).job).toMatchObject({ status: "partial", attemptCount: 2 });
  });

  it("fails the job visibly when it was killed on its last attempt", async () => {
    const jobId = await killedMidJob(3, past());
    const recovery = await recoverProviderJobs(db());
    expect(recovery.failed).toBeGreaterThanOrEqual(1);
    expect(recovery.due).not.toContain(jobId);
    const read = await readJob(jobId);
    expect(read.job).toMatchObject({ status: "failed", terminal: true, errorCode: JOB_ERRORS.WORKER_LOST });
    expect(read.job.errorMessage).toMatch(/worker stopped/i);
    expect(read.job.completedAt).toBeTruthy();
    expect(await runProviderJob(db(), config, jobId, { ...permitted, fetchProfile: neverCalled })).toEqual({ state: "skipped" });
  });

  it("leaves a job alone while a live worker still holds it", async () => {
    const jobId = await killedMidJob(1, new Date(Date.now() + 60_000));
    const recovery = await recoverProviderJobs(db());
    expect(recovery.due).not.toContain(jobId);
    expect(await runProviderJob(db(), config, jobId, { ...permitted, fetchProfile: neverCalled })).toEqual({ state: "skipped" });
    expect((await jobRow(jobId)).status).toBe("running");
  });

  it("hands a queued job the queue lost back to a worker, once per pass window", async () => {
    const { job } = await createJob(profileUrl(unique("lost-message")));
    expect((await recoverProviderJobs(db())).due).not.toContain(job.id);
    await db().update(enrichmentJobs).set({ updatedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(enrichmentJobs.id, job.id));
    expect((await recoverProviderJobs(db())).due).toContain(job.id);
    expect((await recoverProviderJobs(db())).due).not.toContain(job.id);
  });

  it("an interrupted worker cannot overwrite the outcome after losing its lease", async () => {
    await connect();
    const { job } = await createJob(profileUrl(unique("stale-worker")));
    const slow: ProviderJobDeps["fetchProfile"] = async () => {
      // While this worker waits on the provider, recovery decides it is gone and the job fails.
      await db().update(enrichmentJobs).set({ status: "failed", errorCode: JOB_ERRORS.WORKER_LOST, completedAt: new Date() }).where(eq(enrichmentJobs.id, job.id));
      return { requestPath: "/v2/acc/users/x", status: 200, payload: PROVIDER_PAYLOAD, payloadHash: "b".repeat(64), latencyMs: 1 };
    };
    expect(await runProviderJob(db(), config, job.id, { ...permitted, fetchProfile: slow })).toEqual({ state: "skipped" });
    expect((await jobRow(job.id)).status).toBe("failed");
  });

  it("fails an in-request waterfall job its process abandoned", async () => {
    const { job } = await createJob(profileUrl(unique("waterfall")));
    const [stuck] = await db()
      .insert(enrichmentJobs)
      .values({ workspaceId: WORKSPACE, prospectId: job.targetId, status: "running", queuedAt: new Date(Date.now() - 45 * 60_000) })
      .returning();
    const [recent] = await db().insert(enrichmentJobs).values({ workspaceId: WORKSPACE, prospectId: job.targetId, status: "running" }).returning();
    expect((await recoverProviderJobs(db())).abandonedWaterfall).toBeGreaterThanOrEqual(1);
    expect(await jobRow(stuck!.id)).toMatchObject({ status: "failed", errorCode: JOB_ERRORS.WORKER_LOST });
    expect((await jobRow(recent!.id)).status).toBe("running");
  });

  it("removes raw provider responses past their retention and keeps the attempt", async () => {
    await connect();
    const { job } = await createJob(profileUrl(unique("retention")));
    await runProviderJob(db(), config, job.id, { ...permitted, fetchProfile: respondWith(PROVIDER_PAYLOAD) });
    expect(await purgeExpiredProviderResponses(db(), new Date(Date.now() + 89 * 86_400_000))).toBe(0);
    await purgeExpiredProviderResponses(db(), new Date(Date.now() + 91 * 86_400_000));
    const read = await readJob(job.id);
    expect(read.attempts).toHaveLength(1);
    expect(read.attempts[0]!.hasRawResponse).toBe(false);
  });
});

describe("ENR-04 provider connections", () => {
  it("lists providers and connections without any secret", async () => {
    await connect();
    const res = await get("/enrichment/providers");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers[0]).toMatchObject({ id: "unipile", legalStatus: "pending_legal_review", permitted: false });
    expect(body.connections[0]).toMatchObject({ provider: "unipile", externalAccountId: "unipile-account-1", status: "active", credentialSource: "platform" });
    expect(res.body).not.toContain("platform-unipile-key");
    expect(Object.keys(body.connections[0])).not.toEqual(expect.arrayContaining(["credentialRef", "apiKey", "keyHint"]));

    const [row] = await db().select().from(enrichmentProviderConnections).where(eq(enrichmentProviderConnections.workspaceId, WORKSPACE));
    expect(row!.credentialRef).toBe("platform:unipile");
    expect(JSON.stringify(row)).not.toContain("platform-unipile-key");
  });

  it("refuses to connect a provider that is not permitted, and ignores a client-supplied credential", async () => {
    const refused = await post("/enrichment/provider-connections/unipile", { externalAccountId: "unipile-account-2" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("provider_not_permitted");
    const withSecret = await post("/enrichment/provider-connections/unipile", { externalAccountId: "x", credentialRef: "platform:unipile", apiKey: "sneaky" });
    expect(withSecret.statusCode).toBe(422);
  });

  it("only connects an account that exists under the stored credential", async () => {
    const actor = { workspaceId: WORKSPACE, userId: ownerId };
    const lister = async () => [{ id: "whatsapp-1", type: "WHATSAPP" }];
    await expect(connectUnipileAccount(db(), config, actor, { externalAccountId: "nope" }, { lister, permission: permitted.permission })).rejects.toMatchObject({ code: "provider_account_not_found" });
    await expect(connectUnipileAccount(db(), config, actor, { externalAccountId: "whatsapp-1" }, { lister, permission: permitted.permission })).rejects.toMatchObject({ code: "provider_account_not_linkedin" });
    await expect(
      connectUnipileAccount(db(), { ...config, UNIPILE_API_KEY: undefined }, actor, { externalAccountId: "x" }, { lister, permission: permitted.permission })
    ).rejects.toMatchObject({ code: "provider_credential_required" });
  });

  it("lets only administrators manage connections, and audits connect and disconnect", async () => {
    const connection = await connect();
    expect((await post("/enrichment/provider-connections/unipile", { externalAccountId: "a" }, member)).statusCode).toBe(403);
    expect((await del(`/enrichment/provider-connections/${connection.id}`, member)).statusCode).toBe(403);
    expect((await del(`/enrichment/provider-connections/${connection.id}`, outsider)).statusCode).toBe(404);

    const removed = await del(`/enrichment/provider-connections/${connection.id}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().connection.status).toBe("revoked");
    const actions = (await db().select().from(auditLogs).where(and(eq(auditLogs.workspaceId, WORKSPACE), eq(auditLogs.entityId, connection.id)))).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["enrichment.provider_connection.connect", "enrichment.provider_connection.disconnect"]));

    // A job that was queued against the connection ends ACTION_REQUIRED once it is gone.
    const { job } = await createJob(profileUrl(unique("after-disconnect")));
    await runProviderJob(db(), config, job.id, { ...permitted, fetchProfile: neverCalled });
    expect((await readJob(job.id)).job.errorCode).toBe(JOB_ERRORS.PROVIDER_CONNECTION_REQUIRED);
  });

  it("scopes jobs to their workspace and to the enrich permission", async () => {
    const { job } = await createJobOverHttp(profileUrl(unique("scope")), member);
    expect((await get(`/enrichment/provider-jobs/${job.id}`, member)).statusCode).toBe(200);
    expect((await get(`/enrichment/provider-jobs/${job.id}`, outsider)).statusCode).toBe(404);
    expect((await get("/enrichment/provider-jobs", outsider)).json().total).toBe(0);
    expect((await get("/enrichment/provider-jobs/not-a-uuid")).statusCode).toBe(404);
    // Provider jobs do not appear among the waterfall jobs.
    const waterfall = (await get("/enrichment/jobs")).json();
    expect(waterfall.data.some((entry: { id: string }) => entry.id === job.id)).toBe(false);
  });
});

describe("ENR-04 contact data", () => {
  async function personWithResults(results: Array<{ fieldName: string; fieldValue?: string; fieldValueJson?: unknown; sourceProvider: string; confidence?: string; validationStatus?: string }>) {
    const { job } = await createJob(profileUrl(unique("contact")));
    const [waterfall] = await db()
      .insert(enrichmentJobs)
      .values({ workspaceId: WORKSPACE, prospectId: job.targetId, status: "completed", completedAt: new Date() })
      .returning();
    if (results.length) {
      await db()
        .insert(enrichmentResults)
        .values(results.map((result) => ({ ...result, enrichmentJobId: waterfall!.id, workspaceId: WORKSPACE, prospectId: job.targetId })));
    }
    return { prospectId: job.targetId, waterfall: waterfall! };
  }
  const contactData = async (prospectId: string) => (await get(`/enrichment/people/${prospectId}/contact-data`)).json().contactData;

  it("leaves absent contact data absent", async () => {
    const { prospectId } = await personWithResults([]);
    const data = await contactData(prospectId);
    expect(data.email).toBeNull();
    expect(data.phone).toBeNull();
    expect(data.otherPhones).toEqual([]);
    expect(data.lastRun.status).toBe("done");
  });

  it("gives a provider email its provider, provenance and verification status", async () => {
    const { prospectId, waterfall } = await personWithResults([
      { fieldName: "email", fieldValue: "priya@initech.example", sourceProvider: "hunter", confidence: "0.9300" },
      { fieldName: "email_status", fieldValue: "valid", fieldValueJson: { status: "valid", deliverabilityScore: 96 }, sourceProvider: "zerobounce", validationStatus: "valid" },
      { fieldName: "phone", fieldValue: "+15550100", fieldValueJson: { mobile: "+15550100", direct: "+15550101" }, sourceProvider: "datagma" },
    ]);
    const data = await contactData(prospectId);
    expect(data.email).toMatchObject({
      value: "priya@initech.example",
      provenance: { kind: "provider", provider: "hunter", jobId: waterfall.id, correlationId: waterfall.correlationId, confidence: 0.93 },
      verification: { status: "valid", provider: "zerobounce", deliverabilityScore: 96 },
      freshness: { ageDays: 0, stale: false },
    });
    expect(data.phone).toMatchObject({
      value: "+15550100",
      provenance: { kind: "provider", provider: "datagma" },
      verification: { status: "unverified", provider: null },
    });
    expect(data.otherPhones).toEqual([{ type: "direct", value: "+15550101" }]);
  });

  it("shows an unverified provider email as unverified, not as valid", async () => {
    const { prospectId } = await personWithResults([{ fieldName: "email", fieldValue: "sam@initech.example", sourceProvider: "hunter" }]);
    expect((await contactData(prospectId)).email).toMatchObject({ value: "sam@initech.example", verification: { status: "unverified", provider: null, verifiedAt: null } });
  });

  it("never shows a guessed, fabricated or sample value", async () => {
    const guessed = await personWithResults([
      { fieldName: "email", fieldValue: "first.last@initech.example", sourceProvider: "pattern-gen", confidence: "0.4000" },
      { fieldName: "email_status", fieldValue: "catch_all", sourceProvider: "zerobounce", validationStatus: "catch_all" },
      { fieldName: "phone", sourceProvider: "phone-gate", validationStatus: "skipped", fieldValueJson: { reason: "score" } },
    ]);
    expect(await contactData(guessed.prospectId)).toMatchObject({ email: null, phone: null });

    const fabricated = await personWithResults([
      { fieldName: "email", fieldValue: "stub@initech.example", sourceProvider: "stub-hunter" },
      { fieldName: "phone", fieldValue: "+15550199", fieldValueJson: { mobile: "+15550199", sampleData: true }, sourceProvider: "contactout", validationStatus: "sample" },
    ]);
    expect(await contactData(fabricated.prospectId)).toMatchObject({ email: null, phone: null });
  });

  it("shows a pattern-built address only once the verifier confirmed it, and says so", async () => {
    const { prospectId } = await personWithResults([
      { fieldName: "email", fieldValue: "first.last@initech.example", sourceProvider: "pattern-gen", confidence: "0.4000" },
      { fieldName: "email_status", fieldValue: "valid", sourceProvider: "zerobounce", validationStatus: "valid" },
    ]);
    expect((await contactData(prospectId)).email).toMatchObject({ provenance: { kind: "pattern_verified", provider: "pattern-gen" }, verification: { status: "valid", provider: "zerobounce" } });
  });

  it("attributes a value on the CRM record and marks old data stale", async () => {
    const { prospectId } = await personWithResults([]);
    const old = new Date(Date.now() - 120 * 86_400_000);
    await db()
      .update(contacts)
      .set({ email: "typed@initech.example", phone: "+15550123", fieldSources: { email: { source: "manual", setAt: old.toISOString() } } })
      .where(and(eq(contacts.workspaceId, WORKSPACE), eq(contacts.sourceProspectId, prospectId)));
    const data = await contactData(prospectId);
    expect(data.email).toMatchObject({ value: "typed@initech.example", provenance: { kind: "manual", provider: "manual" }, verification: { status: "unverified" }, freshness: { stale: true } });
    expect(data.phone).toMatchObject({ value: "+15550123", provenance: { kind: "crm_record", provider: "unattributed" }, verification: { status: "unverified" } });
  });

  it("applies a stored verdict only to the address it was given for", async () => {
    const { prospectId } = await personWithResults([{ fieldName: "email", fieldValue: "new@initech.example", sourceProvider: "hunter" }]);
    await db().insert(schema.emailVerifications).values({ workspaceId: WORKSPACE, prospectId, email: "old@initech.example", status: "valid", deliverabilityScore: 99, provider: "email-intel" });
    expect((await contactData(prospectId)).email.verification.status).toBe("unverified");
    await db().update(schema.emailVerifications).set({ email: "NEW@initech.example" }).where(and(eq(schema.emailVerifications.workspaceId, WORKSPACE), eq(schema.emailVerifications.prospectId, prospectId)));
    expect((await contactData(prospectId)).email.verification).toMatchObject({ status: "valid", provider: "email-intel", deliverabilityScore: 99 });
  });

  it("refuses to verify when there is no email, and scopes contact data to the workspace", async () => {
    const { prospectId } = await personWithResults([]);
    const res = await post(`/enrichment/people/${prospectId}/contact-data/verify-email`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("no_email");
    expect((await get(`/enrichment/people/${prospectId}/contact-data`, outsider)).statusCode).toBe(404);
    expect((await get("/enrichment/people/unknown-prospect/contact-data")).statusCode).toBe(404);
  });

  it("does not treat the stub verifier as a verification service", async () => {
    const { prospectId } = await personWithResults([{ fieldName: "email", fieldValue: "sam@initech.example", sourceProvider: "hunter" }]);
    const res = await post(`/enrichment/people/${prospectId}/contact-data/verify-email`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("verifier_not_configured");
    expect((await contactData(prospectId)).email.verification.status).toBe("unverified");
  });
});
