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

describe("Entitlements routes", () => {
  it("sets and lists an entitlement for the caller's own workspace", async () => {
    const app = await buildTestApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/entitlements/max_seats",
      headers: json("ent-basic@test.com"),
      payload: { value: 10 },
    });
    if (put.statusCode === 503) {
      await app.close();
      return;
    }
    expect(put.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/entitlements",
      headers: asUser("ent-basic@test.com"),
    });
    const body = list.json() as { data: Array<{ key: string; value: unknown }> };
    expect(body.data.find((e) => e.key === "max_seats")?.value).toBe(10);
    await app.close();
  });

  describe("workspace isolation", () => {
    it("an entitlement set in one workspace is invisible to and unaffected by another workspace's same key", async () => {
      const app = await buildTestApp();

      const putA = await app.inject({
        method: "PUT",
        url: "/api/v1/entitlements/max_seats",
        headers: json("ent-iso-userA@test.com"),
        payload: { value: 25 },
      });
      if (putA.statusCode === 503) {
        await app.close();
        return;
      }
      expect(putA.statusCode).toBe(200);

      // Workspace B never set this key — must not see workspace A's value.
      const listB = await app.inject({
        method: "GET",
        url: "/api/v1/entitlements",
        headers: asUser("ent-iso-userB@test.com"),
      });
      const bodyB = listB.json() as { data: Array<{ key: string; value: unknown }> };
      expect(bodyB.data.some((e) => e.key === "max_seats")).toBe(false);

      // Workspace B setting the same key must not clobber workspace A's row.
      const putB = await app.inject({
        method: "PUT",
        url: "/api/v1/entitlements/max_seats",
        headers: json("ent-iso-userB@test.com"),
        payload: { value: 5 },
      });
      expect(putB.statusCode).toBe(200);

      const deleteB = await app.inject({
        method: "DELETE",
        url: "/api/v1/entitlements/max_seats",
        headers: asUser("ent-iso-userB@test.com"),
      });
      expect(deleteB.statusCode).toBe(204);

      const listAAfter = await app.inject({
        method: "GET",
        url: "/api/v1/entitlements",
        headers: asUser("ent-iso-userA@test.com"),
      });
      const bodyAAfter = listAAfter.json() as { data: Array<{ key: string; value: unknown }> };
      expect(bodyAAfter.data.find((e) => e.key === "max_seats")?.value).toBe(25);

      await app.close();
    });
  });
});
