import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("CRM service E2E", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({
      ...config,
      CLERK_SECRET_KEY: undefined,
      AUTH_STUB: true,
      LOG_LEVEL: "fatal",
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  function asUser(email: string) {
    return { "x-stub-user-email": email };
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
});
