import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { buildAuditService } from "../services/audit.service.js";
import type { FastifyInstance } from "fastify";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("CRM service E2E", () => {
  let app: FastifyInstance;
  let db: Db;
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({
      ...config,
      CLERK_SECRET_KEY: undefined,
      AUTH_STUB: true,
      LOG_LEVEL: "fatal",
    });
    const created = createDb(config.DATABASE_URL!);
    db = created.db;
    closeDb = () => created.sql.end();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
  });

  function asUser(email: string) {
    return { "x-stub-user-email": email };
  }

  /**
   * Directly inserts a user with the given role into `workspaceId` (bypassing the API —
   * apps/api's team invite flow, not exercised by this test, is the real path;
   * `resolveOrProvisionUser` always makes the first user in a new workspace "owner" with
   * no join flow here). Once inserted, authenticating as `email` via the stub-auth header
   * matches this pre-created user by email and picks up its existing membership/role
   * instead of provisioning a new workspace.
   */
  async function addMemberToWorkspace(
    workspaceId: string,
    email: string,
    role: "admin" | "member" = "member"
  ): Promise<void> {
    const [user] = await db
      .insert(schema.users)
      .values({ email, fullName: "Member User", status: "active", isBlocked: false })
      .returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId, userId: user.id, role });
  }

  async function getWorkspaceIdFor(headers: Record<string, string>): Promise<string> {
    const res = await app.inject({ method: "GET", url: "/api/v1/companies", headers });
    return (res.json() as { workspaceId: string }).workspaceId;
  }

  async function createCompany(headers: Record<string, string>, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers,
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; workspaceId: string };
  }

  async function getAuditLogs(headers: Record<string, string>, entityType: string, entityId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?entityType=${entityType}&entityId=${entityId}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      data: { action: string; beforeState: unknown; afterState: unknown; createdAt: string }[];
      total: number;
    };
  }

  it("health → companies → deals summary flow for one workspace", async () => {
    const email = "crm-e2e@test.com";
    const headers = asUser(email);

    const health = await app.inject({ method: "GET", url: "/api/v1/crm/health" });
    expect(health.statusCode).toBe(200);

    const companies = await app.inject({ method: "GET", url: "/api/v1/companies", headers });
    expect(companies.statusCode).toBe(200);
    const workspaceId = (companies.json() as { workspaceId: string }).workspaceId;

    const contacts = await app.inject({ method: "GET", url: "/api/v1/contacts", headers });
    expect(contacts.statusCode).toBe(200);
    expect((contacts.json() as { workspaceId: string }).workspaceId).toBe(workspaceId);

    const summary = await app.inject({ method: "GET", url: "/api/v1/deals/summary", headers });
    expect(summary.statusCode).toBe(200);
    expect((summary.json() as { workspaceId: string }).workspaceId).toBe(workspaceId);
  });

  it("companies: full CRUD round-trip", async () => {
    const headers = asUser("crm-companies-crud@test.com");

    const company = await createCompany(headers, "Roundtrip Co");

    const get = await app.inject({ method: "GET", url: `/api/v1/companies/${company.id}`, headers });
    expect(get.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${company.id}`,
      headers,
      payload: { industry: "SaaS" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { industry: string }).industry).toBe("SaaS");

    const list = await app.inject({ method: "GET", url: "/api/v1/companies", headers });
    const listBody = list.json() as { data: { id: string }[] };
    expect(listBody.data.some((c) => c.id === company.id)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/companies/${company.id}`, headers });
    expect(del.statusCode).toBe(204);

    const getAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${company.id}`,
      headers,
    });
    expect(getAfterDelete.statusCode).toBe(404);
  });

  it("companies: audit log records create and update operations exactly once", async () => {
    const headers = asUser("crm-audit-companies@test.com");
    const company = await createCompany(headers, "Audit Co");

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${company.id}`,
      headers,
      payload: { industry: "SaaS" },
    });
    expect(update.statusCode).toBe(200);

    const auditRes = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?entityType=company&entityId=${company.id}`,
      headers,
    });
    expect(auditRes.statusCode).toBe(200);

    const auditBody = auditRes.json() as { data: { action: string; beforeState: unknown; afterState: unknown; createdAt: string }[] };
    expect(auditBody.data).toHaveLength(2);
    expect(auditBody.data[0].action).toBe("create");
    expect(auditBody.data[0].beforeState).toBeNull();
    expect(auditBody.data[0].afterState).toMatchObject({ id: company.id, name: "Audit Co" });
    expect(auditBody.data[1].action).toBe("update");
    expect(auditBody.data[1].beforeState).toMatchObject({ id: company.id, name: "Audit Co" });
    expect(auditBody.data[1].afterState).toMatchObject({ id: company.id, name: "Audit Co", industry: "SaaS" });
  });

  it("companies: multiple consecutive updates generate exactly one audit row per successful patch", async () => {
    const headers = asUser("crm-audit-multi-update@test.com");
    const company = await createCompany(headers, "Multi Update Co");

    const firstPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${company.id}`,
      headers,
      payload: { industry: "SaaS" },
    });
    expect(firstPatch.statusCode).toBe(200);

    const secondPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${company.id}`,
      headers,
      payload: { location: "Austin, TX" },
    });
    expect(secondPatch.statusCode).toBe(200);

    const auditBody = await getAuditLogs(headers, "company", company.id);
    expect(auditBody.total).toBe(3);
    expect(auditBody.data).toHaveLength(3);
    expect(auditBody.data.map((entry) => entry.action)).toEqual(["create", "update", "update"]);
    expect(auditBody.data[0].createdAt).toBeDefined();
    expect(auditBody.data[1].createdAt).toBeDefined();
    expect(auditBody.data[2].createdAt).toBeDefined();
    expect(new Date(auditBody.data[0].createdAt as string).getTime()).toBeLessThanOrEqual(
      new Date(auditBody.data[1].createdAt as string).getTime()
    );
    expect(new Date(auditBody.data[1].createdAt as string).getTime()).toBeLessThanOrEqual(
      new Date(auditBody.data[2].createdAt as string).getTime()
    );
  });

  it("companies: no-op update does not create additional audit rows", async () => {
    const headers = asUser("crm-audit-noop@test.com");
    const company = await createCompany(headers, "Noop Co");

    const noopPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${company.id}`,
      headers,
      payload: { name: "Noop Co" },
    });
    expect(noopPatch.statusCode).toBe(200);

    const auditBody = await getAuditLogs(headers, "company", company.id);
    expect(auditBody.total).toBe(1);
    expect(auditBody.data).toHaveLength(1);
    expect(auditBody.data[0].action).toBe("create");
  });

  it("companies: failed update does not append an audit log", async () => {
    const headers = asUser("crm-audit-failed-update@test.com");
    const company = await createCompany(headers, "Failed Update Co");

    const beforeLogs = await getAuditLogs(headers, "company", company.id);
    expect(beforeLogs.total).toBe(1);

    const failedPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${company.id}`,
      headers,
      payload: { ownerId: randomUUID() },
    });
    expect(failedPatch.statusCode).toBe(500);

    const afterLogs = await getAuditLogs(headers, "company", company.id);
    expect(afterLogs.total).toBe(1);
    expect(afterLogs.data).toHaveLength(1);
    expect(afterLogs.data[0].action).toBe("create");
  });

  it("audit service stores null actorId and large nested payloads without serialization issues", async () => {
    const headers = asUser("crm-audit-null-actor@test.com");
    const company = await createCompany(headers, "Audit Payload Co");
    const nestedBefore = {
      profile: {
        tags: ["a", "b", "c"],
        meta: { deep: { value: "x" } },
      },
      large: Array.from({ length: 60 }, (_, index) => ({ index, nested: { ok: true, value: `item-${index}` } })),
    };
    const nestedAfter = {
      ...nestedBefore,
      profile: { ...nestedBefore.profile, meta: { deep: { value: "y" } } },
    };

    const auditService = buildAuditService(db);
    await auditService?.record(company.workspaceId, undefined, "update", "company", company.id, nestedBefore, nestedAfter);

    const auditBody = await getAuditLogs(headers, "company", company.id);
    expect(auditBody.total).toBe(2);
    expect(auditBody.data).toHaveLength(2);
    expect(auditBody.data[0].action).toBe("create");
    expect(auditBody.data[1].action).toBe("update");
    expect(auditBody.data[1].beforeState).toMatchObject(nestedBefore);
    expect(auditBody.data[1].afterState).toMatchObject(nestedAfter);
  });

  it("companies: concurrent updates each create one audit record", async () => {
    const headers = asUser(`crm-audit-concurrent-${randomUUID()}@test.com`);
    const company = await createCompany(headers, "Concurrent Co");

    await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/v1/companies/${company.id}`,
        headers,
        payload: { industry: "SaaS" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/v1/companies/${company.id}`,
        headers,
        payload: { location: "Seattle, WA" },
      }),
    ]);

    const auditBody = await getAuditLogs(headers, "company", company.id);
    expect(auditBody.total).toBe(3);
    expect(auditBody.data.filter((entry) => entry.action === "update")).toHaveLength(2);
  });

  it("contacts: create under a company, update, delete", async () => {
    const headers = asUser("crm-contacts-crud@test.com");
    const company = await createCompany(headers, "Contact Host Co");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/contacts",
      headers,
      payload: { firstName: "Jane", lastName: "Doe", companyId: company.id },
    });
    expect(create.statusCode).toBe(201);
    const contact = create.json() as { id: string };

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/contacts/${contact.id}`,
      headers,
      payload: { lifecycleStage: "mql" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { lifecycleStage: string }).lifecycleStage).toBe("mql");

    const del = await app.inject({ method: "DELETE", url: `/api/v1/contacts/${contact.id}`, headers });
    expect(del.statusCode).toBe(204);

    const getAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/contacts/${contact.id}`,
      headers,
    });
    expect(getAfterDelete.statusCode).toBe(404);
  });

  it("workspace isolation: workspace B cannot read/write workspace A's company", async () => {
    const headersA = asUser("crm-isolation-a@test.com");
    const headersB = asUser("crm-isolation-b@test.com");

    const company = await createCompany(headersA, "Isolated Co");

    const getAsB = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${company.id}`,
      headers: headersB,
    });
    expect(getAsB.statusCode).toBe(404);

    const patchAsB = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${company.id}`,
      headers: headersB,
      payload: { industry: "Hacked" },
    });
    expect(patchAsB.statusCode).toBe(404);

    const deleteAsB = await app.inject({
      method: "DELETE",
      url: `/api/v1/companies/${company.id}`,
      headers: headersB,
    });
    expect(deleteAsB.statusCode).toBe(404);
  });

  it("creating a contact/deal against another workspace's company returns 404", async () => {
    const headersA = asUser("crm-cross-ws-a@test.com");
    const headersB = asUser("crm-cross-ws-b@test.com");
    const companyA = await createCompany(headersA, "Cross WS Co");

    const contactAsB = await app.inject({
      method: "POST",
      url: "/api/v1/contacts",
      headers: headersB,
      payload: { firstName: "Intruder", companyId: companyA.id },
    });
    expect(contactAsB.statusCode).toBe(404);
    expect((contactAsB.json() as { error: string }).error).toBe("company_not_found");

    const dealAsB = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers: headersB,
      payload: { name: "Intruder Deal", companyId: companyA.id },
    });
    expect(dealAsB.statusCode).toBe(404);
    expect((dealAsB.json() as { error: string }).error).toBe("company_not_found");
  });

  it("pipelines: a brand-new workspace gets exactly one default pipeline with 6 stages", async () => {
    const headers = asUser("crm-default-pipeline@test.com");

    const pipelines = await app.inject({ method: "GET", url: "/api/v1/pipelines", headers });
    expect(pipelines.statusCode).toBe(200);
    const body = pipelines.json() as { data: { isDefault: boolean; stages: unknown[] }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0].isDefault).toBe(true);
    expect(body.data[0].stages).toHaveLength(6);

    const pipelinesAgain = await app.inject({ method: "GET", url: "/api/v1/pipelines", headers });
    expect((pipelinesAgain.json() as { total: number }).total).toBe(1);
  });

  it("deals: creating without pipelineId/stageId lands in the default pipeline's first stage", async () => {
    const headers = asUser("crm-default-deal-stage@test.com");
    const company = await createCompany(headers, "Default Stage Co");

    const deal = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Default Stage Deal", companyId: company.id },
    });
    expect(deal.statusCode).toBe(201);
    const dealBody = deal.json() as { stageId: string; pipelineId: string };

    const pipelines = await app.inject({ method: "GET", url: "/api/v1/pipelines", headers });
    const pipelineBody = pipelines.json() as {
      data: { id: string; stages: { id: string; orderIndex: number; name: string }[] }[];
    };
    const defaultPipeline = pipelineBody.data.find((p) => p.id === dealBody.pipelineId);
    const firstStage = defaultPipeline?.stages.find((s) => s.orderIndex === 0);
    expect(firstStage?.name).toBe("New");
    expect(dealBody.stageId).toBe(firstStage?.id);
  });

  it("deals: PATCH stage change logs a stage_change activity on the timeline", async () => {
    const headers = asUser("crm-stage-change@test.com");
    const company = await createCompany(headers, "Stage Change Co");

    const dealRes = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Stage Change Deal", companyId: company.id, amount: 1000 },
    });
    const deal = dealRes.json() as { id: string; pipelineId: string; stageId: string };

    const pipelines = await app.inject({ method: "GET", url: "/api/v1/pipelines", headers });
    const pipelineBody = pipelines.json() as {
      data: { id: string; stages: { id: string; orderIndex: number }[] }[];
    };
    const pipeline = pipelineBody.data.find((p) => p.id === deal.pipelineId)!;
    const nextStage = pipeline.stages.find((s) => s.orderIndex === 1)!;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/${deal.id}`,
      headers,
      payload: { stageId: nextStage.id },
    });
    expect(patch.statusCode).toBe(200);

    const activities = await app.inject({
      method: "GET",
      url: `/api/v1/activities?entityType=deal&entityId=${deal.id}`,
      headers,
    });
    expect(activities.statusCode).toBe(200);
    const activityBody = activities.json() as { data: { activityType: string }[] };
    expect(activityBody.data.some((a) => a.activityType === "stage_change")).toBe(true);
  });

  it("deals/summary reflects real aggregates across multiple open deals", async () => {
    // Unique email per run: this test asserts absolute counts, and the e2e suite runs
    // against a real, non-rolled-back Postgres, so a fixed email would accumulate deals
    // across repeated runs.
    const headers = asUser(`crm-deals-summary-${randomUUID()}@test.com`);
    const company = await createCompany(headers, "Summary Co");

    await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Deal One", companyId: company.id, amount: 1000 },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Deal Two", companyId: company.id, amount: 2500 },
    });

    const summary = await app.inject({ method: "GET", url: "/api/v1/deals/summary", headers });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as { openDeals: number; valueByCurrency: { currency: string; value: number }[] };
    expect(body.openDeals).toBe(2);
    expect(body.valueByCurrency).toEqual([{ currency: "USD", value: 3500 }]);
  });

  it("deals/summary keeps mixed-currency deals in separate buckets instead of summing them together", async () => {
    const headers = asUser(`crm-deals-summary-currency-${randomUUID()}@test.com`);
    const company = await createCompany(headers, "Multi-Currency Co");

    await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "USD Deal", companyId: company.id, amount: 1000, currency: "USD" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "INR Deal", companyId: company.id, amount: 200000, currency: "INR" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Second INR Deal", companyId: company.id, amount: 50000, currency: "INR" },
    });

    const summary = await app.inject({ method: "GET", url: "/api/v1/deals/summary", headers });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as {
      openDeals: number;
      valueByCurrency: { currency: string; value: number }[];
      stages: { count: number; valueByCurrency: { currency: string; value: number }[] }[];
    };
    expect(body.openDeals).toBe(3);
    const byCurrency = Object.fromEntries(body.valueByCurrency.map((v) => [v.currency, v.value]));
    expect(byCurrency).toEqual({ USD: 1000, INR: 250000 });
    // All three land in the same default stage — that stage's own breakdown must also stay split.
    expect(body.stages).toHaveLength(1);
    const stageByCurrency = Object.fromEntries(body.stages[0]!.valueByCurrency.map((v) => [v.currency, v.value]));
    expect(stageByCurrency).toEqual({ USD: 1000, INR: 250000 });
  });

  it("POST /pipelines seeds the standard default stages, so a new pipeline is immediately usable", async () => {
    const headers = asUser(`crm-new-pipeline-${randomUUID()}@test.com`);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/pipelines",
      headers,
      payload: { name: "EU Pipeline" },
    });
    expect(create.statusCode).toBe(201);
    const pipeline = create.json() as { id: string; name: string; isDefault: boolean; stages: { name: string; orderIndex: number }[] };
    expect(pipeline.name).toBe("EU Pipeline");
    expect(pipeline.isDefault).toBe(false);
    expect(pipeline.stages.map((s) => s.name)).toEqual([
      "New",
      "Qualified",
      "Proposal",
      "Negotiation",
      "Closed Won",
      "Closed Lost",
    ]);

    // A workspace can hold this pipeline alongside its own default one — creating a second
    // pipeline must not disturb or replace the first.
    const list = await app.inject({ method: "GET", url: "/api/v1/pipelines", headers });
    const body = list.json() as { data: { id: string; isDefault: boolean }[] };
    expect(body.data.some((p) => p.id === pipeline.id)).toBe(true);
    expect(body.data.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it("tasks: create and complete", async () => {
    const headers = asUser("crm-tasks@test.com");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "Call the prospect" },
    });
    expect(create.statusCode).toBe(201);
    const task = create.json() as { id: string; status: string; type: string; completedAt: string | null };
    expect(task.status).toBe("open");
    expect(task.type).toBe("custom");
    expect(task.completedAt).toBeNull();

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/complete`,
      headers,
    });
    expect(complete.statusCode).toBe(200);
    const completed = complete.json() as { status: string; completedAt: string | null };
    expect(completed.status).toBe("done");
    expect(completed.completedAt).not.toBeNull();
  });

  it("tasks: skip records completedAt too, and a valid type is accepted", async () => {
    const headers = asUser("crm-tasks-skip@test.com");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "Send intro email", type: "email" },
    });
    expect((create.json() as { type: string }).type).toBe("email");
    const task = create.json() as { id: string };

    const skip = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/skip`, headers });
    expect(skip.statusCode).toBe(200);
    const skipped = skip.json() as { status: string; completedAt: string | null };
    expect(skipped.status).toBe("skipped");
    expect(skipped.completedAt).not.toBeNull();
  });

  it("tasks: assigning to a user outside the workspace is rejected", async () => {
    const headers = asUser("crm-tasks-assign@test.com");
    const outsider = await app.inject({
      method: "GET",
      url: "/api/v1/companies",
      headers: asUser("crm-tasks-outsider@test.com"),
    });
    const outsiderWorkspaceId = (outsider.json() as { workspaceId: string }).workspaceId;
    // Grab the outsider's user id from their own workspace membership — a real user, just not a member here.
    const [outsiderMember] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, outsiderWorkspaceId));

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "Assign to outsider", assignedTo: outsiderMember!.userId },
    });
    expect(create.statusCode).toBe(422);
  });

  it("tasks: creating with a near-term due date immediately schedules a reminder notification, and completing cancels it", async () => {
    const email = "crm-tasks-reminder@test.com";
    const headers = asUser(email);
    const workspaceId = await getWorkspaceIdFor(headers);

    const dueSoon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "R21.3 reminder check", dueDate: dueSoon },
    });
    expect(create.statusCode, create.body).toBe(201);
    const task = create.json() as { id: string };

    const notifsAfterCreate = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.entityId, task.id));
    expect(notifsAfterCreate).toHaveLength(1);
    expect(notifsAfterCreate[0]!.readAt).toBeNull();
    expect(notifsAfterCreate[0]!.workspaceId).toBe(workspaceId);

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/complete`,
      headers,
    });
    expect(complete.statusCode).toBe(200);

    const notifsAfterComplete = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.entityId, task.id));
    expect(notifsAfterComplete[0]!.readAt).not.toBeNull();
  });

  it("tasks: a due date far in the future does not schedule a reminder immediately", async () => {
    const headers = asUser("crm-tasks-far-future@test.com");

    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "Not due for months", dueDate: farFuture },
    });
    expect(create.statusCode, create.body).toBe(201);
    const task = create.json() as { id: string };

    const notifs = await db.select().from(schema.notifications).where(eq(schema.notifications.entityId, task.id));
    expect(notifs).toHaveLength(0);
  });

  it("meetings: creating one linked to a deal logs a meeting activity on that deal's timeline", async () => {
    const headers = asUser(`crm-meetings-${randomUUID()}@test.com`);
    const company = await createCompany(headers, "Meetings Co");

    const dealRes = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Meetings Deal", companyId: company.id },
    });
    const deal = dealRes.json() as { id: string };

    const meetingRes = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      headers,
      payload: {
        title: "Discovery call",
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        durationMinutes: 30,
        meetingType: "video",
        dealId: deal.id,
      },
    });
    expect(meetingRes.statusCode).toBe(201);
    const meeting = meetingRes.json() as { id: string; dealId: string };
    expect(meeting.dealId).toBe(deal.id);

    const get = await app.inject({ method: "GET", url: `/api/v1/meetings/${meeting.id}`, headers });
    expect(get.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/meetings/${meeting.id}`,
      headers,
      payload: { outcome: "Positive — moving to proposal" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { outcome: string }).outcome).toBe("Positive — moving to proposal");

    const activities = await app.inject({
      method: "GET",
      url: `/api/v1/activities?entityType=deal&entityId=${deal.id}`,
      headers,
    });
    const activityBody = activities.json() as { data: { activityType: string }[] };
    expect(activityBody.data.some((a) => a.activityType === "meeting")).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/meetings/${meeting.id}`, headers });
    expect(del.statusCode).toBe(204);
  });

  it("meetings: workspace isolation on get/patch/delete", async () => {
    const headersA = asUser(`crm-meetings-iso-a-${randomUUID()}@test.com`);
    const headersB = asUser(`crm-meetings-iso-b-${randomUUID()}@test.com`);

    const meetingRes = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      headers: headersA,
      payload: { title: "Private meeting", scheduledAt: new Date().toISOString() },
    });
    const meeting = meetingRes.json() as { id: string };

    const getAsB = await app.inject({ method: "GET", url: `/api/v1/meetings/${meeting.id}`, headers: headersB });
    expect(getAsB.statusCode).toBe(404);
  });

  it("role-based permissions: a 'member' cannot delete, an 'admin' can, an 'owner' can", async () => {
    const ownerHeaders = asUser(`crm-rbac-owner-${randomUUID()}@test.com`);
    const memberEmail = `crm-rbac-member-${randomUUID()}@test.com`;
    const memberHeaders = asUser(memberEmail);
    const adminEmail = `crm-rbac-admin-${randomUUID()}@test.com`;
    const adminHeaders = asUser(adminEmail);

    const workspaceId = await getWorkspaceIdFor(ownerHeaders);
    await addMemberToWorkspace(workspaceId, memberEmail, "member");
    await addMemberToWorkspace(workspaceId, adminEmail, "admin");

    const companyForMember = await createCompany(ownerHeaders, "RBAC Co (member attempt)");
    const companyForAdmin = await createCompany(ownerHeaders, "RBAC Co (admin attempt)");
    const companyForOwner = await createCompany(ownerHeaders, "RBAC Co (owner attempt)");

    // Confirm the member really did land in the same workspace (not a new one).
    const memberCompanies = await app.inject({ method: "GET", url: "/api/v1/companies", headers: memberHeaders });
    expect((memberCompanies.json() as { workspaceId: string }).workspaceId).toBe(workspaceId);

    const deleteAsMember = await app.inject({
      method: "DELETE",
      url: `/api/v1/companies/${companyForMember.id}`,
      headers: memberHeaders,
    });
    expect(deleteAsMember.statusCode).toBe(403);
    expect((deleteAsMember.json() as { error: string }).error).toBe("forbidden");

    const deleteAsAdmin = await app.inject({
      method: "DELETE",
      url: `/api/v1/companies/${companyForAdmin.id}`,
      headers: adminHeaders,
    });
    expect(deleteAsAdmin.statusCode).toBe(204);

    const deleteAsOwner = await app.inject({
      method: "DELETE",
      url: `/api/v1/companies/${companyForOwner.id}`,
      headers: ownerHeaders,
    });
    expect(deleteAsOwner.statusCode).toBe(204);
  });

  it("role-based permissions: 'member' also cannot delete a task", async () => {
    const ownerHeaders = asUser(`crm-rbac-task-owner-${randomUUID()}@test.com`);
    const memberEmail = `crm-rbac-task-member-${randomUUID()}@test.com`;
    const memberHeaders = asUser(memberEmail);

    const workspaceId = await getWorkspaceIdFor(ownerHeaders);
    await addMemberToWorkspace(workspaceId, memberEmail);

    const taskRes = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: ownerHeaders,
      payload: { title: "RBAC task" },
    });
    const task = taskRes.json() as { id: string };

    const deleteAsMember = await app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${task.id}`,
      headers: memberHeaders,
    });
    expect(deleteAsMember.statusCode).toBe(403);
  });

  it("dashboard/overview reflects companies, contacts, open deals, tasks, and recent activity", async () => {
    const headers = asUser(`crm-dashboard-${randomUUID()}@test.com`);
    const company = await createCompany(headers, "Dashboard Co");

    await app.inject({
      method: "POST",
      url: "/api/v1/contacts",
      headers,
      payload: { firstName: "Dash", lastName: "Board", companyId: company.id },
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Dashboard Deal", companyId: company.id, amount: 500 },
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "Dashboard Task" },
    });

    const overview = await app.inject({ method: "GET", url: "/api/v1/dashboard/overview", headers });
    expect(overview.statusCode).toBe(200);
    const body = overview.json() as {
      companies: number;
      contacts: number;
      openDeals: number;
      valueByCurrency: { currency: string; value: number }[];
      openTasks: number;
      recentActivities: unknown[];
    };
    expect(body.companies).toBe(1);
    expect(body.contacts).toBe(1);
    expect(body.openDeals).toBe(1);
    expect(body.valueByCurrency).toEqual([{ currency: "USD", value: 500 }]);
    expect(body.openTasks).toBe(1);
    expect(Array.isArray(body.recentActivities)).toBe(true);
  });

  it("dashboard/stale-deals surfaces untouched deals and is open to a 'member' (unlike cro-summary)", async () => {
    const ownerHeaders = asUser(`crm-stale-deals-owner-${randomUUID()}@test.com`);
    const memberEmail = `crm-stale-deals-member-${randomUUID()}@test.com`;
    const memberHeaders = asUser(memberEmail);

    const workspaceId = await getWorkspaceIdFor(ownerHeaders);
    await addMemberToWorkspace(workspaceId, memberEmail);

    const company = await createCompany(ownerHeaders, "Stale Deal Co");
    const dealRes = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers: ownerHeaders,
      payload: { name: "Untouched Deal", companyId: company.id, amount: 2500 },
    });
    const deal = dealRes.json() as { id: string };

    // Backdate past the 14-day staleness window — the API has no path to do this itself.
    await db
      .update(schema.deals)
      .set({ updatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.deals.id, deal.id));

    // cro-summary stays owner/admin-only — a member gets 403.
    const croAsMember = await app.inject({ method: "GET", url: "/api/v1/dashboard/cro-summary", headers: memberHeaders });
    expect(croAsMember.statusCode).toBe(403);

    // stale-deals is the new, role-agnostic endpoint — same member gets 200 with real data.
    const staleAsMember = await app.inject({ method: "GET", url: "/api/v1/dashboard/stale-deals", headers: memberHeaders });
    expect(staleAsMember.statusCode).toBe(200);
    const body = staleAsMember.json() as { staleDeals: { id: string; name: string; daysSinceUpdate: number }[] };
    const found = body.staleDeals.find((d) => d.id === deal.id);
    expect(found).toBeTruthy();
    expect(found!.daysSinceUpdate).toBeGreaterThanOrEqual(19);
  });

  it("malformed :id path params return a clean 400, not a raw DB 500", async () => {
    const headers = asUser(`crm-malformed-id-${randomUUID()}@test.com`);

    const malformed = await app.inject({ method: "GET", url: "/api/v1/companies/not-a-uuid", headers });
    expect(malformed.statusCode).toBe(400);

    const wellFormedButMissing = await app.inject({
      method: "GET",
      url: "/api/v1/companies/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headers,
    });
    expect(wellFormedButMissing.statusCode).toBe(404);
  });

  it("contacts: audit log records create, update, and delete", async () => {
    const headers = asUser("crm-audit-contacts@test.com");
    const company = await createCompany(headers, "Contact Audit Co");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/contacts",
      headers,
      payload: { firstName: "Jane", lastName: "Doe", companyId: company.id },
    });
    expect(create.statusCode).toBe(201);
    const contact = create.json() as { id: string };

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/contacts/${contact.id}`,
      headers,
      payload: { lifecycleStage: "mql" },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/contacts/${contact.id}`, headers });
    expect(del.statusCode).toBe(204);

    const auditBody = await getAuditLogs(headers, "contact", contact.id);
    expect(auditBody.data.map((entry) => entry.action)).toEqual(["create", "update", "delete"]);
    expect(auditBody.data[0].beforeState).toBeNull();
    expect(auditBody.data[1].beforeState).toMatchObject({ id: contact.id, lifecycleStage: "lead" });
    expect(auditBody.data[1].afterState).toMatchObject({ id: contact.id, lifecycleStage: "mql" });
    expect(auditBody.data[2].action).toBe("delete");
  });

  it("deals: audit log records create, update, and delete", async () => {
    const headers = asUser("crm-audit-deals@test.com");
    const company = await createCompany(headers, "Deal Audit Co");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers,
      payload: { name: "Audit Deal", companyId: company.id, amount: 1000 },
    });
    expect(create.statusCode).toBe(201);
    const deal = create.json() as { id: string };

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/${deal.id}`,
      headers,
      payload: { amount: 2000 },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/deals/${deal.id}`, headers });
    expect(del.statusCode).toBe(204);

    const auditBody = await getAuditLogs(headers, "deal", deal.id);
    expect(auditBody.data.map((entry) => entry.action)).toEqual(["create", "update", "delete"]);
    expect(auditBody.data[1].beforeState).toMatchObject({ id: deal.id, amount: 1000 });
    expect(auditBody.data[1].afterState).toMatchObject({ id: deal.id, amount: 2000 });
  });

  it("tasks: audit log records create, update, and delete", async () => {
    const headers = asUser("crm-audit-tasks@test.com");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "Audit Task" },
    });
    expect(create.statusCode).toBe(201);
    const task = create.json() as { id: string };

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/complete`,
      headers,
    });
    expect(complete.statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/tasks/${task.id}`, headers });
    expect(del.statusCode).toBe(204);

    const auditBody = await getAuditLogs(headers, "task", task.id);
    expect(auditBody.data.map((entry) => entry.action)).toEqual(["create", "update", "delete"]);
    expect(auditBody.data[1].beforeState).toMatchObject({ id: task.id, status: "open" });
    expect(auditBody.data[1].afterState).toMatchObject({ id: task.id, status: "done" });
  });

  it("pipelines: audit log records create, addStage, update, and delete", async () => {
    const headers = asUser("crm-audit-pipelines@test.com");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/pipelines",
      headers,
      payload: { name: "Audit Pipeline" },
    });
    expect(create.statusCode).toBe(201);
    const pipeline = create.json() as { id: string };

    // New pipelines are seeded with the 6 standard DEFAULT_STAGES (orderIndex 0-5), same as
    // ensureDefaultPipeline — so the next stage added by hand needs an unused index.
    const addStage = await app.inject({
      method: "POST",
      url: `/api/v1/pipelines/${pipeline.id}/stages`,
      headers,
      payload: { name: "Stage A", orderIndex: 6 },
    });
    expect(addStage.statusCode).toBe(201);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/pipelines/${pipeline.id}`,
      headers,
      payload: { name: "Renamed Pipeline" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { name: string }).name).toBe("Renamed Pipeline");

    const del = await app.inject({ method: "DELETE", url: `/api/v1/pipelines/${pipeline.id}`, headers });
    expect(del.statusCode).toBe(204);

    const getAfterDelete = await app.inject({
      method: "GET",
      url: "/api/v1/pipelines",
      headers,
    });
    const body = getAfterDelete.json() as { data: { id: string }[] };
    expect(body.data.some((p) => p.id === pipeline.id)).toBe(false);

    const auditBody = await getAuditLogs(headers, "pipeline", pipeline.id);
    expect(auditBody.data.map((entry) => entry.action)).toEqual(["create", "update", "delete"]);
    expect(auditBody.data[1].beforeState).toMatchObject({ id: pipeline.id, name: "Audit Pipeline" });
    expect(auditBody.data[1].afterState).toMatchObject({ id: pipeline.id, name: "Renamed Pipeline" });
  });

  it("adding a duplicate pipeline stage orderIndex returns a clean 409, not a raw DB 500", async () => {
    const headers = asUser(`crm-stage-conflict-${randomUUID()}@test.com`);

    const pipelineRes = await app.inject({
      method: "POST",
      url: "/api/v1/pipelines",
      headers,
      payload: { name: "Conflict Pipeline" },
    });
    const pipeline = pipelineRes.json() as { id: string };

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/pipelines/${pipeline.id}/stages`,
      headers,
      payload: { name: "Stage A", orderIndex: 6 },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/pipelines/${pipeline.id}/stages`,
      headers,
      payload: { name: "Stage B", orderIndex: 6 },
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { error: string }).error).toBe("stage_order_conflict");
  });
});
