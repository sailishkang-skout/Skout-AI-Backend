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

describe("Number request routes", () => {
  it("creates a request and fetches it back for the caller's own workspace", async () => {
    const app = await buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/numbers/requests",
      headers: json("numreq-basic@test.com"),
      payload: { country: "US" },
    });
    if (created.statusCode === 503) {
      await app.close();
      return;
    }
    expect(created.statusCode).toBe(201);
    const { id } = (created.json() as { data: { id: string } }).data;

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/numbers/requests/${id}`,
      headers: asUser("numreq-basic@test.com"),
    });
    expect(get.statusCode).toBe(200);
    await app.close();
  });

  describe("workspace isolation", () => {
    it("a number request created in one workspace is not fetchable or listed from another", async () => {
      const app = await buildTestApp();

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/numbers/requests",
        headers: json("numreq-iso-userA@test.com"),
        payload: { country: "US" },
      });
      if (created.statusCode === 503) {
        await app.close();
        return;
      }
      const { id } = (created.json() as { data: { id: string } }).data;

      const crossGet = await app.inject({
        method: "GET",
        url: `/api/v1/numbers/requests/${id}`,
        headers: asUser("numreq-iso-userB@test.com"),
      });
      expect(crossGet.statusCode).toBe(404);

      const crossSelect = await app.inject({
        method: "POST",
        url: `/api/v1/numbers/requests/${id}/select`,
        headers: json("numreq-iso-userB@test.com"),
        payload: { phoneNumber: "+15551234567" },
      });
      expect(crossSelect.statusCode).toBe(404);

      const crossList = await app.inject({
        method: "GET",
        url: "/api/v1/numbers/requests",
        headers: asUser("numreq-iso-userB@test.com"),
      });
      const crossListBody = crossList.json() as { data: Array<{ id: string }> };
      expect(crossListBody.data.some((r) => r.id === id)).toBe(false);

      // Still reachable from the owning workspace.
      const ownGet = await app.inject({
        method: "GET",
        url: `/api/v1/numbers/requests/${id}`,
        headers: asUser("numreq-iso-userA@test.com"),
      });
      expect(ownGet.statusCode).toBe(200);

      await app.close();
    });
  });
});
