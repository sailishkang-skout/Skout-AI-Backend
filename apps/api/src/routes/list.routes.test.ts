import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
    EXPORTS_BUCKET: undefined,
  });
}, 30000);

afterAll(async () => {
  await app?.close();
});

function asUser(email: string) {
  return { "x-stub-user-email": email };
}

describe("list routes — CRUD lifecycle", () => {
  it("POST /lists creates a list and returns 201 with correct shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser("list-create@test.com"), "content-type": "application/json" },
      payload: { name: "My First List" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; workspaceId: string; prospectCount: number; createdAt: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe("My First List");
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.prospectCount).toBe(0);
    expect(body.createdAt).toBeTruthy();
  });

  it("GET /lists returns the lists for the workspace", async () => {
    const email = "list-index@test.com";

    await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Index Test List" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { id: string; name: string }[]; total: number; workspaceId: string };
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.some((l) => l.name === "Index Test List")).toBe(true);
  });

  it("GET /lists/:id returns the list by id", async () => {
    const email = "list-show@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Show Me List" },
    });
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${id}`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; name: string };
    expect(body.id).toBe(id);
    expect(body.name).toBe("Show Me List");
    expect(Array.isArray((body as { members?: unknown[] }).members)).toBe(true);
  });

  it("GET /lists/:id members include a signals overlay array (R11.3)", async () => {
    const email = "list-signals-overlay@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Signal Overlay List" },
    });
    const { id } = created.json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { prospectIds: ["overlay-p1"] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${id}`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      members: { prospectId: string; signals: { type: string; observedAt: string; detail?: string }[] }[];
    };
    expect(body.members).toHaveLength(1);
    expect(body.members[0].prospectId).toBe("overlay-p1");
    expect(Array.isArray(body.members[0].signals)).toBe(true);
  });

  it("POST /lists/:id/members adds prospects and returns list with members array", async () => {
    const email = "list-addmembers@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Members List" },
    });
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { prospectIds: ["prospect-a", "prospect-b"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      prospectCount: number;
      members: { prospectId: string; companyId: string; snapshot: Record<string, unknown>; addedAt: string }[];
    };
    expect(body.id).toBe(id);
    expect(body.prospectCount).toBe(2);
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members).toHaveLength(2);
    expect(body.members.map((m) => m.prospectId).sort()).toEqual(["prospect-a", "prospect-b"]);
    expect(body.members[0].addedAt).toBeTruthy();
  });

  it("GET /lists/:id/members returns the members array", async () => {
    const email = "list-getmembers@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Get Members List" },
    });
    const { id } = created.json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { prospectIds: ["p-x", "p-y", "p-z"] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${id}/members`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    const members = res.json() as { prospectId: string; companyId: string; snapshot: Record<string, unknown>; addedAt: string }[];
    expect(Array.isArray(members)).toBe(true);
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.prospectId).sort()).toEqual(["p-x", "p-y", "p-z"]);
    members.forEach((m) => {
      expect(m.prospectId).toBeTruthy();
      expect(m.companyId).toBeTruthy();
      expect(m.addedAt).toBeTruthy();
      expect(typeof m.snapshot).toBe("object");
    });
  });

  it("POST /lists/:id/members is idempotent — duplicate prospect IDs are not double-inserted", async () => {
    const email = "list-idempotent@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Idempotent List" },
    });
    const { id } = created.json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { prospectIds: ["dup-1"] },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { prospectIds: ["dup-1"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { prospectCount: number; members: unknown[] };
    expect(body.prospectCount).toBe(1);
    expect(body.members).toHaveLength(1);
  });

  it("prospectCount on GET /lists matches the number of added members", async () => {
    const email = "list-count@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Count Check List" },
    });
    const { id } = created.json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { prospectIds: ["c1", "c2", "c3"] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${id}`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { prospectCount: number }).prospectCount).toBe(3);
  });
});

describe("list routes — workspace isolation", () => {
  it("users from different workspaces cannot see each other's lists", async () => {
    const resA = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser("isolation-userA@test.com"), "content-type": "application/json" },
      payload: { name: "User A Private List" },
    });
    const { id: listAId } = resA.json() as { id: string };

    const resB = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listAId}`,
      headers: asUser("isolation-userB@test.com"),
    });
    expect(resB.statusCode).toBe(404);

    const index = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: asUser("isolation-userB@test.com"),
    });
    const body = index.json() as { data: { id: string }[] };
    expect(body.data.some((l) => l.id === listAId)).toBe(false);
  });

  it("users from different workspaces cannot add members to each other's lists", async () => {
    const resA = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser("isolation-ownerA@test.com"), "content-type": "application/json" },
      payload: { name: "Owner A List" },
    });
    const { id } = resA.json() as { id: string };

    const resB = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser("isolation-ownerB@test.com"), "content-type": "application/json" },
      payload: { prospectIds: ["stolen-p1"] },
    });
    expect(resB.statusCode).toBe(404);
  });

  it("users from different workspaces cannot GET members of each other's lists", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser("isolation-memberA@test.com"), "content-type": "application/json" },
      payload: { name: "Secret Members List" },
    });
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${id}/members`,
      headers: asUser("isolation-memberB@test.com"),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("list routes — 404 and validation", () => {
  it("GET /lists/:id returns 404 for a non-existent list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/lists/00000000-0000-4000-8000-000000000000",
      headers: asUser("notfound@test.com"),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /lists/:id/members returns 404 for a non-existent list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/lists/00000000-0000-4000-8000-000000000000/members",
      headers: asUser("notfound-members@test.com"),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /lists/:id/members returns 404 for a non-existent list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/lists/00000000-0000-4000-8000-000000000000/members",
      headers: { ...asUser("notfound-add@test.com"), "content-type": "application/json" },
      payload: { prospectIds: ["p1"] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /lists rejects an empty name with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser("validation@test.com"), "content-type": "application/json" },
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /lists rejects a missing name with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser("validation-missing@test.com"), "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /lists/:id/members rejects empty prospectIds array with 400", async () => {
    const email = "validation-members@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Validation List" },
    });
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${id}/members`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { prospectIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("list routes — auth stub", () => {
  it("same email always maps to the same workspaceId across requests", async () => {
    const email = "stable-workspace@test.com";

    const r1 = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: asUser(email),
    });
    const r2 = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: asUser(email),
    });

    const w1 = (r1.json() as { workspaceId: string }).workspaceId;
    const w2 = (r2.json() as { workspaceId: string }).workspaceId;
    expect(w1).toBe(w2);
    expect(w1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("different emails map to different workspaceIds", async () => {
    const r1 = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: asUser("workspace-alpha@test.com"),
    });
    const r2 = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: asUser("workspace-beta@test.com"),
    });

    const w1 = (r1.json() as { workspaceId: string }).workspaceId;
    const w2 = (r2.json() as { workspaceId: string }).workspaceId;
    expect(w1).not.toBe(w2);
  });
});

describe("list routes — CSV export", () => {
  it("GET /lists/:id/export/csv returns export metadata and inline CSV when no bucket", async () => {
    const email = "list-csv@test.com";

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "CSV Export List" },
    });
    const { id } = created.json() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${id}/export/csv`,
      headers: asUser(email),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json() as {
      filename: string;
      creditsUsed: number;
      memberCount: number;
      exportKey?: string;
      content?: string;
      downloadUrl: string;
    };
    expect(body.filename).toContain(".csv");
    expect(body.creditsUsed).toBe(2);
    expect(body.memberCount).toBe(0);
    expect(body.content).toContain("Full Name");
    expect(body.exportKey).toBeTruthy();
    expect(body.downloadUrl).toContain("/export/csv/download");

    if (!body.content) {
      const download = await app.inject({
        method: "GET",
        url: `/api/v1/lists/${id}/export/csv/download?key=${encodeURIComponent(body.exportKey!)}`,
        headers: asUser(email),
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-type"]).toContain("text/csv");
      expect(download.body).toContain("Full Name");
    }
  });
});
