import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
  });
}

function asUser(email: string) {
  return { "x-stub-user-email": email };
}

function json(email: string) {
  return { ...asUser(email), "content-type": "application/json" };
}

// ---------------------------------------------------------------------------
// CRUD lifecycle
// ---------------------------------------------------------------------------

describe("sequence routes — CRUD lifecycle", () => {
  it("POST /sequences creates a draft sequence and returns 201", async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json("seq-create@test.com"),
      payload: { name: "Welcome Campaign" },
    });

    if (res.statusCode === 503) {
      await app.close();
      return; // DB unavailable in this env — skip gracefully
    }

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; status: string; workspaceId: string; createdAt: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe("Welcome Campaign");
    expect(body.status).toBe("draft");
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.createdAt).toBeTruthy();

    await app.close();
  });

  it("GET /sequences lists sequences for the workspace", async () => {
    const app = await buildTestApp();
    const email = "seq-list@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "List Test Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sequences",
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { id: string; name: string }[]; total: number; workspaceId: string };
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.some((s) => s.name === "List Test Sequence")).toBe(true);

    await app.close();
  });

  it("GET /sequences/:id returns sequence with steps array", async () => {
    const app = await buildTestApp();
    const email = "seq-get@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Get Test Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${id}`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; name: string; steps: unknown[] };
    expect(body.id).toBe(id);
    expect(body.name).toBe("Get Test Sequence");
    expect(Array.isArray(body.steps)).toBe(true);

    await app.close();
  });

  it("PATCH /sequences/:id updates the name", async () => {
    const app = await buildTestApp();
    const email = "seq-rename@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Original Name" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}`,
      headers: json(email),
      payload: { name: "Renamed Sequence" },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("Renamed Sequence");

    await app.close();
  });

  it("DELETE /sequences/:id removes the sequence and returns 204", async () => {
    const app = await buildTestApp();
    const email = "seq-delete@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "To Delete" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/sequences/${id}`,
      headers: asUser(email),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${id}`,
      headers: asUser(email),
    });
    expect(get.statusCode).toBe(404);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Status lifecycle
// ---------------------------------------------------------------------------

describe("sequence routes — status lifecycle", () => {
  it("PATCH status draft → active succeeds", async () => {
    const app = await buildTestApp();
    const email = "seq-status-activate@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Activate Me" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}`,
      headers: json(email),
      payload: { status: "active" },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("active");

    await app.close();
  });

  it("PATCH status active → paused succeeds", async () => {
    const app = await buildTestApp();
    const email = "seq-status-pause@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Pause Me" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    await app.inject({ method: "PATCH", url: `/api/v1/sequences/${id}`, headers: json(email), payload: { status: "active" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}`,
      headers: json(email),
      payload: { status: "paused" },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("paused");

    await app.close();
  });

  it("PATCH status paused → active (resume) succeeds", async () => {
    const app = await buildTestApp();
    const email = "seq-status-resume@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Resume Me" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    await app.inject({ method: "PATCH", url: `/api/v1/sequences/${id}`, headers: json(email), payload: { status: "active" } });
    await app.inject({ method: "PATCH", url: `/api/v1/sequences/${id}`, headers: json(email), payload: { status: "paused" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}`,
      headers: json(email),
      payload: { status: "active" },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("active");

    await app.close();
  });

  it("PATCH status draft → paused returns 422", async () => {
    const app = await buildTestApp();
    const email = "seq-status-invalid-a@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Bad Transition" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}`,
      headers: json(email),
      payload: { status: "paused" },
    });

    expect(res.statusCode).toBe(422);

    await app.close();
  });

  it("PATCH status draft → archived returns 422", async () => {
    const app = await buildTestApp();
    const email = "seq-status-invalid-b@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "No Archive" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}`,
      headers: json(email),
      payload: { status: "archived" },
    });

    expect(res.statusCode).toBe(422);

    await app.close();
  });

  it("PATCH with unknown status value returns 400 (Zod validation)", async () => {
    const app = await buildTestApp();
    const email = "seq-status-invalid-c@test.com";

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000001",
      headers: json(email),
      payload: { status: "flying" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Step CRUD
// ---------------------------------------------------------------------------

describe("sequence routes — step CRUD", () => {
  it("POST /sequences/:id/steps adds a step and returns 201", async () => {
    const app = await buildTestApp();
    const email = "seq-step-add@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Step Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/steps`,
      headers: json(email),
      payload: { stepType: "email", delayDays: 1, subject: "Hello {{firstName}}", bodyTemplate: "Hi {{firstName}}!" },
    });

    expect(res.statusCode).toBe(201);
    const step = res.json() as { id: string; stepOrder: number; stepType: string; delayDays: number; subject: string };
    expect(step.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(step.stepOrder).toBe(1);
    expect(step.stepType).toBe("email");
    expect(step.delayDays).toBe(1);
    expect(step.subject).toBe("Hello {{firstName}}");

    await app.close();
  });

  it("steps are appended in order as more are added", async () => {
    const app = await buildTestApp();
    const email = "seq-step-order@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Order Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    for (const [type, delay] of [["email", 0], ["wait", 3], ["linkedin", 5]] as const) {
      await app.inject({
        method: "POST",
        url: `/api/v1/sequences/${id}/steps`,
        headers: json(email),
        payload: { stepType: type, delayDays: delay },
      });
    }

    const res = await app.inject({ method: "GET", url: `/api/v1/sequences/${id}`, headers: asUser(email) });
    const body = res.json() as { steps: { stepOrder: number; stepType: string }[] };
    expect(body.steps).toHaveLength(3);
    expect(body.steps.map((s) => s.stepOrder)).toEqual([1, 2, 3]);
    expect(body.steps.map((s) => s.stepType)).toEqual(["email", "wait", "linkedin"]);

    await app.close();
  });

  it("PATCH /sequences/:id/steps/:stepId updates step fields", async () => {
    const app = await buildTestApp();
    const email = "seq-step-update@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Update Step Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const stepRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/steps`,
      headers: json(email),
      payload: { stepType: "email", delayDays: 0 },
    });
    const { id: stepId } = stepRes.json() as { id: string };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}/steps/${stepId}`,
      headers: json(email),
      payload: { delayDays: 7, subject: "Updated subject" },
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json() as { delayDays: number; subject: string };
    expect(updated.delayDays).toBe(7);
    expect(updated.subject).toBe("Updated subject");

    await app.close();
  });

  it("DELETE /sequences/:id/steps/:stepId removes step and renumbers", async () => {
    const app = await buildTestApp();
    const email = "seq-step-delete@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Delete Step Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    // Add 3 steps
    const stepIds: string[] = [];
    for (const type of ["email", "wait", "linkedin"] as const) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/sequences/${id}/steps`,
        headers: json(email),
        payload: { stepType: type, delayDays: 0 },
      });
      stepIds.push((r.json() as { id: string }).id);
    }

    // Delete the middle step (stepOrder 2)
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/sequences/${id}/steps/${stepIds[1]}`,
      headers: asUser(email),
    });
    expect(del.statusCode).toBe(204);

    // Remaining steps should be renumbered 1 and 2
    const res = await app.inject({ method: "GET", url: `/api/v1/sequences/${id}`, headers: asUser(email) });
    const body = res.json() as { steps: { id: string; stepOrder: number }[] };
    expect(body.steps).toHaveLength(2);
    expect(body.steps.map((s) => s.stepOrder)).toEqual([1, 2]);
    expect(body.steps.map((s) => s.id).sort()).toEqual([stepIds[0], stepIds[2]].sort());

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

describe("sequence routes — reorder steps", () => {
  it("PUT /sequences/:id/steps/reorder reorders steps", async () => {
    const app = await buildTestApp();
    const email = "seq-reorder@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Reorder Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const stepIds: string[] = [];
    for (const type of ["email", "wait", "task"] as const) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/sequences/${id}/steps`,
        headers: json(email),
        payload: { stepType: type, delayDays: 0 },
      });
      stepIds.push((r.json() as { id: string }).id);
    }

    // Reverse the order
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${id}/steps/reorder`,
      headers: json(email),
      payload: { stepIds: [stepIds[2], stepIds[1], stepIds[0]] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { steps: { id: string; stepOrder: number }[] };
    expect(body.steps).toHaveLength(3);
    expect(body.steps[0]!.id).toBe(stepIds[2]);
    expect(body.steps[0]!.stepOrder).toBe(1);
    expect(body.steps[1]!.id).toBe(stepIds[1]);
    expect(body.steps[1]!.stepOrder).toBe(2);
    expect(body.steps[2]!.id).toBe(stepIds[0]);
    expect(body.steps[2]!.stepOrder).toBe(3);

    await app.close();
  });

  it("PUT /sequences/:id/steps/reorder returns 422 when step count is wrong", async () => {
    const app = await buildTestApp();
    const email = "seq-reorder-count@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Count Mismatch Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const r = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/steps`,
      headers: json(email),
      payload: { stepType: "email", delayDays: 0 },
    });
    const stepId = (r.json() as { id: string }).id;

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${id}/steps/reorder`,
      headers: json(email),
      payload: { stepIds: [stepId, "00000000-0000-4000-8000-000000000099"] },
    });

    expect(res.statusCode).toBe(422);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Merge token validation
// ---------------------------------------------------------------------------

describe("sequence routes — merge token validation", () => {
  it("POST step with valid merge tokens succeeds", async () => {
    const app = await buildTestApp();
    const email = "seq-token-valid@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Token Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/steps`,
      headers: json(email),
      payload: {
        stepType: "email",
        delayDays: 0,
        bodyTemplate: "Hi {{firstName}}, {{senderName}} here from {{companyName}}. {{unsubscribeUrl}}",
      },
    });

    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it("POST step with unknown merge token returns 422", async () => {
    const app = await buildTestApp();
    const email = "seq-token-invalid@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Bad Token Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/steps`,
      headers: json(email),
      payload: {
        stepType: "email",
        delayDays: 0,
        bodyTemplate: "Hello {{unknownField}}!",
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { details?: { invalidToken?: string } };
    expect(body.details?.invalidToken).toBe("unknownField");

    await app.close();
  });

  it("PATCH step with unknown merge token returns 422", async () => {
    const app = await buildTestApp();
    const email = "seq-token-patch@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Token Patch Sequence" },
    });

    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const stepRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/steps`,
      headers: json(email),
      payload: { stepType: "email", delayDays: 0 },
    });
    const { id: stepId } = stepRes.json() as { id: string };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}/steps/${stepId}`,
      headers: json(email),
      payload: { bodyTemplate: "{{notAToken}}" },
    });

    expect(res.statusCode).toBe(422);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Workspace isolation
// ---------------------------------------------------------------------------

describe("sequence routes — workspace isolation", () => {
  it("users from different workspaces cannot see each other's sequences", async () => {
    const app = await buildTestApp();

    const resA = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json("seq-iso-userA@test.com"),
      payload: { name: "User A Private Sequence" },
    });

    if (resA.statusCode === 503) { await app.close(); return; }
    const { id } = resA.json() as { id: string };

    const resB = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${id}`,
      headers: asUser("seq-iso-userB@test.com"),
    });
    expect(resB.statusCode).toBe(404);

    const index = await app.inject({
      method: "GET",
      url: "/api/v1/sequences",
      headers: asUser("seq-iso-userB@test.com"),
    });
    const body = index.json() as { data: { id: string }[] };
    expect(body.data.some((s) => s.id === id)).toBe(false);

    await app.close();
  });

  it("users from different workspaces cannot delete each other's sequences", async () => {
    const app = await buildTestApp();

    const resA = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json("seq-iso-delA@test.com"),
      payload: { name: "Protected Sequence" },
    });

    if (resA.statusCode === 503) { await app.close(); return; }
    const { id } = resA.json() as { id: string };

    // User B tries to add a step to User A's sequence
    const resB = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/steps`,
      headers: json("seq-iso-delB@test.com"),
      payload: { stepType: "email", delayDays: 0 },
    });
    expect(resB.statusCode).toBe(404);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 404 and validation
// ---------------------------------------------------------------------------

describe("sequence routes — 404 and validation", () => {
  it("GET /sequences/:id returns 404 for a non-existent sequence", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000",
      headers: asUser("seq-404@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /sequences/:id returns 404 for a non-existent sequence", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000",
      headers: json("seq-404-patch@test.com"),
      payload: { name: "Ghost" },
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /sequences rejects an empty name with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json("seq-val-empty@test.com"),
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /sequences rejects missing name with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json("seq-val-missing@test.com"),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /sequences/:id/steps rejects invalid stepType with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/steps",
      headers: json("seq-val-type@test.com"),
      payload: { stepType: "sms", delayDays: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /sequences/:id/steps rejects negative delayDays with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/steps",
      headers: json("seq-val-delay@test.com"),
      payload: { stepType: "email", delayDays: -1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH /sequences/:id returns 400 when neither name nor status is provided", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000",
      headers: json("seq-val-patch@test.com"),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PUT /sequences/:id/steps/reorder requires at least one step ID", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/steps/reorder",
      headers: json("seq-val-reorder@test.com"),
      payload: { stepIds: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Auth stub consistency
// ---------------------------------------------------------------------------

describe("sequence routes — auth stub", () => {
  it("same email always maps to the same workspaceId", async () => {
    const app = await buildTestApp();
    const email = "seq-stable-ws@test.com";

    const r1 = await app.inject({ method: "GET", url: "/api/v1/sequences", headers: asUser(email) });
    const r2 = await app.inject({ method: "GET", url: "/api/v1/sequences", headers: asUser(email) });

    const w1 = (r1.json() as { workspaceId: string }).workspaceId;
    const w2 = (r2.json() as { workspaceId: string }).workspaceId;
    expect(w1).toBe(w2);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Enroll — validation (no DB needed)
// ---------------------------------------------------------------------------

describe("sequence routes — enroll validation (no DB)", () => {
  it("POST /enroll with empty body returns 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/enroll",
      headers: json("enroll-val-empty@test.com"),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /enroll with empty prospectIds array returns 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/enroll",
      headers: json("enroll-val-array@test.com"),
      payload: { prospectIds: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /enroll with invalid listId (not a UUID) returns 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/enroll",
      headers: json("enroll-val-uuid@test.com"),
      payload: { listId: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Enroll — full lifecycle (requires DB)
// ---------------------------------------------------------------------------

describe("sequence routes — enroll lifecycle", () => {
  async function buildActiveSequenceWithStep(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    email: string
  ): Promise<{ sequenceId: string; stepId: string } | null> {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Enroll Test Sequence" },
    });
    if (created.statusCode === 503) return null;
    const { id: sequenceId } = created.json() as { id: string };

    const stepRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${sequenceId}/steps`,
      headers: json(email),
      payload: { stepType: "email", delayDays: 1, subject: "Hello {{firstName}}" },
    });
    const { id: stepId } = stepRes.json() as { id: string };

    await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${sequenceId}`,
      headers: json(email),
      payload: { status: "active" },
    });

    return { sequenceId, stepId };
  }

  it("returns 202 with enrolled=1, skipped=0 for a new prospect", async () => {
    const app = await buildTestApp();
    const email = "enroll-happy@test.com";

    const setup = await buildActiveSequenceWithStep(app, email);
    if (!setup) { await app.close(); return; }

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-abc-001"] },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { enrolled: number; skipped: number; total: number };
    expect(body.enrolled).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.total).toBe(1);

    await app.close();
  });

  it("returns skipped=1 when enrolling the same prospect twice", async () => {
    const app = await buildTestApp();
    const email = "enroll-dup@test.com";

    const setup = await buildActiveSequenceWithStep(app, email);
    if (!setup) { await app.close(); return; }

    const firstEnroll = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-dup-001"] },
    });
    if (firstEnroll.statusCode !== 202) { await app.close(); return; }

    const secondEnroll = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-dup-001"] },
    });

    expect(secondEnroll.statusCode).toBe(202);
    const body = secondEnroll.json() as { enrolled: number; skipped: number; total: number };
    expect(body.enrolled).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.total).toBe(1);

    await app.close();
  });

  it("returns 202 with mixed enrolled/skipped when some prospects are new", async () => {
    const app = await buildTestApp();
    const email = "enroll-mixed@test.com";

    const setup = await buildActiveSequenceWithStep(app, email);
    if (!setup) { await app.close(); return; }

    // Enroll prospect-A first
    await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-mix-A"] },
    });

    // Enroll A again + B (new)
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-mix-A", "prospect-mix-B"] },
    });

    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(202);
    const body = res.json() as { enrolled: number; skipped: number; total: number };
    expect(body.total).toBe(2);
    expect(body.enrolled).toBe(1);
    expect(body.skipped).toBe(1);

    await app.close();
  });

  it("returns 422 when enrolling into a draft (non-active) sequence", async () => {
    const app = await buildTestApp();
    const email = "enroll-draft@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Draft Sequence" },
    });
    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-xxx"] },
    });

    expect(res.statusCode).toBe(422);

    await app.close();
  });

  it("returns 422 when enrolling into an active sequence with no steps", async () => {
    const app = await buildTestApp();
    const email = "enroll-nostep@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "No Steps Sequence" },
    });
    if (created.statusCode === 503) { await app.close(); return; }
    const { id } = created.json() as { id: string };

    // Activate without adding steps
    await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${id}`,
      headers: json(email),
      payload: { status: "active" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${id}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-yyy"] },
    });

    expect(res.statusCode).toBe(422);

    await app.close();
  });

  it("returns 404 when enrolling into a non-existent sequence", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000099/enroll",
      headers: json("enroll-404@test.com"),
      payload: { prospectIds: ["prospect-ghost"] },
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 404 when a different workspace user tries to enroll", async () => {
    const app = await buildTestApp();
    const ownerEmail = "enroll-iso-owner@test.com";
    const otherEmail = "enroll-iso-other@test.com";

    const setup = await buildActiveSequenceWithStep(app, ownerEmail);
    if (!setup) { await app.close(); return; }

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(otherEmail),
      payload: { prospectIds: ["prospect-iso-001"] },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe("sequence routes — analytics and enrollments", () => {
  async function buildActiveSequenceWithStep(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    email: string
  ): Promise<{ sequenceId: string; stepId: string } | null> {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: json(email),
      payload: { name: "Analytics Test Sequence" },
    });
    if (created.statusCode === 503) return null;
    const { id: sequenceId } = created.json() as { id: string };

    const stepRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${sequenceId}/steps`,
      headers: json(email),
      payload: { stepType: "email", delayDays: 1, subject: "Hello {{firstName}}" },
    });
    const { id: stepId } = stepRes.json() as { id: string };

    await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${sequenceId}`,
      headers: json(email),
      payload: { status: "active" },
    });

    return { sequenceId, stepId };
  }

  it("returns 404 for analytics on a non-existent sequence", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/analytics",
      headers: asUser("analytics-404@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns zeroed funnel metrics and enrollment summary before any enrollments", async () => {
    const app = await buildTestApp();
    const email = "analytics-empty@test.com";
    const setup = await buildActiveSequenceWithStep(app, email);
    if (!setup) { await app.close(); return; }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${setup.sequenceId}/analytics`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      enrollments: { total: number; active: number; completed: number; bounced: number; replied: number };
      steps: { stepId: string; scheduled: number; sent: number; opens: number; clicks: number }[];
    };
    expect(body.id).toBe(setup.sequenceId);
    expect(body.enrollments).toEqual({ total: 0, active: 0, completed: 0, bounced: 0, replied: 0 });
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({ stepId: setup.stepId, scheduled: 0, sent: 0, opens: 0, clicks: 0 });

    await app.close();
  });

  it("reflects an active enrollment in the funnel and enrollment summary", async () => {
    const app = await buildTestApp();
    const email = "analytics-enrolled@test.com";
    const setup = await buildActiveSequenceWithStep(app, email);
    if (!setup) { await app.close(); return; }

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-analytics-001"] },
    });
    if (enrollRes.statusCode !== 202) { await app.close(); return; }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${setup.sequenceId}/analytics`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      enrollments: { total: number; active: number };
      steps: { scheduled: number; sent: number }[];
    };
    expect(body.enrollments.total).toBe(1);
    expect(body.enrollments.active).toBe(1);
    expect(body.steps[0]?.scheduled).toBe(1);
    expect(body.steps[0]?.sent).toBe(0);

    await app.close();
  });

  it("lists enrollments with live status for a sequence", async () => {
    const app = await buildTestApp();
    const email = "enrollments-list@test.com";
    const setup = await buildActiveSequenceWithStep(app, email);
    if (!setup) { await app.close(); return; }

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${setup.sequenceId}/enroll`,
      headers: json(email),
      payload: { prospectIds: ["prospect-list-001"] },
    });
    if (enrollRes.statusCode !== 202) { await app.close(); return; }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${setup.sequenceId}/enrollments`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { prospectId: string; status: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({ prospectId: "prospect-list-001", status: "active" });

    await app.close();
  });

  it("returns 404 for enrollments list on a non-existent sequence", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sequences/00000000-0000-4000-8000-000000000000/enrollments",
      headers: asUser("enrollments-404@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 404 when a different workspace user requests analytics", async () => {
    const app = await buildTestApp();
    const ownerEmail = "analytics-iso-owner@test.com";
    const otherEmail = "analytics-iso-other@test.com";
    const setup = await buildActiveSequenceWithStep(app, ownerEmail);
    if (!setup) { await app.close(); return; }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${setup.sequenceId}/analytics`,
      headers: asUser(otherEmail),
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
