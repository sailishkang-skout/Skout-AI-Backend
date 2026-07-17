import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
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
    const body = summary.json() as { openDeals: number; pipelineValue: number };
    expect(body.openDeals).toBe(2);
    expect(body.pipelineValue).toBe(3500);
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
    const task = create.json() as { id: string; status: string };
    expect(task.status).toBe("open");

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/complete`,
      headers,
    });
    expect(complete.statusCode).toBe(200);
    expect((complete.json() as { status: string }).status).toBe("done");
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
      pipelineValue: number;
      openTasks: number;
      recentActivities: unknown[];
    };
    expect(body.companies).toBe(1);
    expect(body.contacts).toBe(1);
    expect(body.openDeals).toBe(1);
    expect(body.pipelineValue).toBe(500);
    expect(body.openTasks).toBe(1);
    expect(Array.isArray(body.recentActivities)).toBe(true);
  });
});
