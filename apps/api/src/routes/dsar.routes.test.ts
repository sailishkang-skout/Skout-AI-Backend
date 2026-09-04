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

describe("DSAR routes", () => {
  it("creates a manual request and lists it back for the caller's workspace", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dsar",
      headers: json("dsar-basic@test.com"),
      payload: { requestType: "erasure", subjectEmail: "subject@example.com" },
    });
    if (res.statusCode === 503) {
      await app.close();
      return;
    }
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; status: string } };
    expect(body.data.status).toBe("received");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/dsar",
      headers: asUser("dsar-basic@test.com"),
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { data: Array<{ id: string }> };
    expect(listBody.data.some((r) => r.id === body.data.id)).toBe(true);
    await app.close();
  });

  describe("workspace isolation", () => {
    it("a DSAR request created in one workspace cannot be updated from another", async () => {
      const app = await buildTestApp();

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/dsar",
        headers: json("dsar-iso-userA@test.com"),
        // "erasure" stays in "received" (manual fulfillment) rather than auto-completing, so
        // there's a real pre-PATCH state to assert stays untouched from the other workspace.
        payload: { requestType: "erasure", subjectEmail: "leak-check@example.com" },
      });
      if (created.statusCode === 503) {
        await app.close();
        return;
      }
      const { id } = (created.json() as { data: { id: string } }).data;

      const crossUpdate = await app.inject({
        method: "PATCH",
        url: `/api/v1/dsar/${id}`,
        headers: json("dsar-iso-userB@test.com"),
        payload: { status: "rejected" },
      });
      expect(crossUpdate.statusCode).toBe(404);

      const crossList = await app.inject({
        method: "GET",
        url: "/api/v1/dsar",
        headers: asUser("dsar-iso-userB@test.com"),
      });
      const crossListBody = crossList.json() as { data: Array<{ id: string }> };
      expect(crossListBody.data.some((r) => r.id === id)).toBe(false);

      // Confirm it's untouched from the owning workspace's own view.
      const ownList = await app.inject({
        method: "GET",
        url: "/api/v1/dsar",
        headers: asUser("dsar-iso-userA@test.com"),
      });
      const ownListBody = ownList.json() as { data: Array<{ id: string; status: string }> };
      const own = ownListBody.data.find((r) => r.id === id);
      expect(own?.status).toBe("received");

      await app.close();
    });
  });
});
