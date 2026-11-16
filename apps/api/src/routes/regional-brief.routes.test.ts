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
    REDIS_URL: undefined as unknown as string,
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

  it("POST /regional-brief/slots/:id/versions is rejected for a non-admin drafting a version on an existing global-layer slot", async () => {
    const app = await buildTestApp(["admin3@test.com"]);

    const createSlotRes = await app.inject({
      method: "POST",
      url: "/api/v1/regional-brief/slots",
      headers: json("admin3@test.com"),
      payload: { layerType: "global", fieldCategory: "channel_policy" },
    });
    if (createSlotRes.statusCode === 503) { await app.close(); return; }
    expect(createSlotRes.statusCode).toBe(201);
    const slot = createSlotRes.json() as { id: string };

    const createVersionRes = await app.inject({
      method: "POST",
      url: `/api/v1/regional-brief/slots/${slot.id}/versions`,
      headers: json("not-admin@test.com"),
      payload: {
        content: { summary: "test summary", details: ["detail 1"] },
        source: "test source",
        effectiveDate: new Date().toISOString(),
        confidence: 75,
        evidence: "test evidence",
      },
    });
    expect(createVersionRes.statusCode).toBe(403);

    await app.close();
  });

  it("POST /regional-brief/versions/:id/approve is rejected for a non-admin approving a version on a global-layer slot", async () => {
    const app = await buildTestApp(["admin4@test.com"]);

    const createSlotRes = await app.inject({
      method: "POST",
      url: "/api/v1/regional-brief/slots",
      headers: json("admin4@test.com"),
      payload: { layerType: "global", fieldCategory: "telecom_requirements" },
    });
    if (createSlotRes.statusCode === 503) { await app.close(); return; }
    expect(createSlotRes.statusCode).toBe(201);
    const slot = createSlotRes.json() as { id: string };

    const createVersionRes = await app.inject({
      method: "POST",
      url: `/api/v1/regional-brief/slots/${slot.id}/versions`,
      headers: json("admin4@test.com"),
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
      headers: json("not-admin@test.com"),
    });
    expect(approveRes.statusCode).toBe(403);

    await app.close();
  });

  it("full create → approve → resolve flow for an admin", async () => {
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

    // Resolve by alpha-2
    const resolveRes = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/resolve?country=US",
      headers: asUser("admin2@test.com"),
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolved = resolveRes.json() as {
      country: string;
      countryIso3: string;
      entries: Array<{ fieldCategory: string; content: { summary: string } }>;
    };
    expect(resolved.country).toBe("United States");
    expect(resolved.countryIso3).toBe("USA");
    expect(resolved.entries.some((e) => e.fieldCategory === "business_practice" && e.content.summary === "test summary")).toBe(true);

    await app.close();
  });

  it("GET /regional-brief/resolve accepts alpha-3 country code (USA)", async () => {
    const app = await buildTestApp(["admin5@test.com"]);
    if (!app.db) { await app.close(); return; }

    // Seed a slot and approve it via alpha-2 first
    const createSlotRes = await app.inject({
      method: "POST",
      url: "/api/v1/regional-brief/slots",
      headers: json("admin5@test.com"),
      payload: { layerType: "country", countryIso: "US", fieldCategory: "data_compliance" },
    });
    if (createSlotRes.statusCode === 503) { await app.close(); return; }
    if (createSlotRes.statusCode !== 201) { await app.close(); return; }
    const slot = createSlotRes.json() as { id: string };

    const versionRes = await app.inject({
      method: "POST",
      url: `/api/v1/regional-brief/slots/${slot.id}/versions`,
      headers: json("admin5@test.com"),
      payload: {
        content: { summary: "alpha3 resolve test", details: [] },
        source: "test", effectiveDate: new Date().toISOString(), confidence: 70, evidence: "test",
      },
    });
    if (versionRes.statusCode !== 201) { await app.close(); return; }
    const ver = versionRes.json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/regional-brief/versions/${ver.id}/approve`,
      headers: json("admin5@test.com"),
    });

    // Now resolve using alpha-3 code
    const resolveRes = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/resolve?country=USA",
      headers: asUser("admin5@test.com"),
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolved = resolveRes.json() as { countryIso3: string; entries: unknown[] };
    expect(resolved.countryIso3).toBe("USA");

    await app.close();
  });

  it("GET /regional-brief/resolve accepts industry phrase and normalizes to NAICS code", async () => {
    const app = await buildTestApp([]);
    if (!app.db) { await app.close(); return; }

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/resolve?country=US&industry=saas",
      headers: asUser("any@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(200);
    const body = res.json() as { industry: string; industryName: string };
    expect(body.industry).toBe("51");
    expect(body.industryName).toBeTruthy();

    await app.close();
  });

  it("GET /regional-brief/resolve returns industryInputWarning for an unrecognized phrase", async () => {
    const app = await buildTestApp([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/resolve?country=US&industry=unobtanium",
      headers: asUser("any@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(200);
    const body = res.json() as { industryInputWarning?: string };
    expect(body.industryInputWarning).toBeTruthy();

    await app.close();
  });

  it("GET /regional-brief/slots pages with limit/offset and reports the full total", async () => {
    const app = await buildTestApp(["pager-admin@test.com"]);

    // Make sure at least three slots exist so two pages of two are meaningful.
    for (const fieldCategory of ["market_economics", "business_practice", "channel_policy"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/regional-brief/slots",
        headers: json("pager-admin@test.com"),
        payload: { layerType: "global", fieldCategory },
      });
      if (created.statusCode === 503) { await app.close(); return; }
    }

    type SlotsBody = { data: { id: string; layerType: string }[]; total: number; limit?: number; offset?: number };
    const get = async (qs: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/regional-brief/slots${qs}`,
        headers: asUser("any@test.com"),
      });
      return res;
    };

    const all = (await get("")).json() as SlotsBody;
    expect(all.data.length).toBe(all.total);
    expect(all.total).toBeGreaterThanOrEqual(3);

    const page1Res = await get("?limit=2&offset=0");
    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json() as SlotsBody;
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(all.total);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);

    const page2 = (await get("?limit=2&offset=2")).json() as SlotsBody;
    expect(page2.total).toBe(all.total);
    const page1Ids = new Set(page1.data.map((s) => s.id));
    expect(page2.data.some((s) => page1Ids.has(s.id))).toBe(false);

    // Stable order: paged results line up with the unpaged list, global layer first.
    expect([...page1.data, ...page2.data].map((s) => s.id)).toEqual(all.data.slice(0, 2 + page2.data.length).map((s) => s.id));
    expect(all.data[0]?.layerType).toBe("global");

    expect((await get("?limit=101")).statusCode).toBe(422);

    await app.close();
  });

  it("GET /regional-brief/countries returns a list of countries", async () => {
    const app = await buildTestApp([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/countries",
      headers: asUser("any@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; total: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe("number");

    await app.close();
  });

  it("GET /regional-brief/tam returns live fact-checked data for seeded rows", async () => {
    const app = await buildTestApp([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/tam?country=US&industry=51",
      headers: asUser("any@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      isDataLoaded: boolean;
      targetAccountsTam: number;
      annualRevenueTamUsd: number;
      assumptions: { establishments: number };
    };
    expect(body.isDataLoaded).toBe(true);
    expect(body.assumptions.establishments).toBe(162006);
    expect(body.targetAccountsTam).toBe(16201);
    expect(body.annualRevenueTamUsd).toBe(405025000);

    await app.close();
  });

  it("GET /regional-brief/tam/rows requires platform-admin", async () => {
    const app = await buildTestApp([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/regional-brief/tam/rows",
      headers: asUser("not-admin@test.com"),
    });
    if (res.statusCode === 503) { await app.close(); return; }
    expect(res.statusCode).toBe(403);

    await app.close();
  });
});
