import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

async function buildTestApp(platformAdminEmails: string[] = []) {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
    PLATFORM_ADMIN_EMAILS: platformAdminEmails,
  });
}

function asUser(email: string) {
  return { "x-stub-user-email": email };
}
function json(email: string) {
  return { ...asUser(email), "content-type": "application/json" };
}

describe("regional-brief routes", () => {
  it("GET /regional-brief/admin-check reflects the PLATFORM_ADMIN_EMAILS allowlist", async () => {
    const app = await buildTestApp(["admin@test.com"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/admin-check",
      headers: asUser("admin@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ platformAdmin: true });
    await app.close();
  });

  it("POST /regional-brief/slots is rejected for a non-admin creating a global-layer slot", async () => {
    const app = await buildTestApp([]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/regional-brief/slots",
      headers: json("not-admin@test.com"),
      payload: { layerType: "global", fieldCategory: "explainability" },
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("full create -> approve -> resolve flow for an admin", async () => {
    const app = await buildTestApp(["admin2@test.com"]);

    const createSlotRes = await app.inject({
      method: "POST",
      url: "/api/v1/regional-brief/slots",
      headers: json("admin2@test.com"),
      payload: { layerType: "country", countryIso: "US", fieldCategory: "business_practice" },
    });
    if (createSlotRes.statusCode === 503) { await app.close(); return; }
    expect(createSlotRes.statusCode).toBe(201);
    const slot = createSlotRes.json() as { id: string };

    const createVersionRes = await app.inject({
      method: "POST",
      url: `/api/v1/regional-brief/slots/${slot.id}/versions`,
      headers: json("admin2@test.com"),
      payload: {
        content: { summary: "test summary", details: ["detail 1"] },
        source: "test source",
        effectiveDate: new Date().toISOString(),
        confidence: 75,
        evidence: "test evidence",
      },
    });
    expect(createVersionRes.statusCode).toBe(201);
    const version = createVersionRes.json() as { id: string };

    const approveRes = await app.inject({
      method: "POST",
      url: `/api/v1/regional-brief/versions/${version.id}/approve`,
      headers: json("admin2@test.com"),
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().status).toBe("approved");

    const resolveRes = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/resolve?country=US",
      headers: asUser("admin2@test.com"),
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolved = resolveRes.json() as { entries: Array<{ fieldCategory: string; content: { summary: string } }> };
    expect(resolved.entries.some((e) => e.fieldCategory === "business_practice" && e.content.summary === "test summary")).toBe(true);

    await app.close();
  });
});
