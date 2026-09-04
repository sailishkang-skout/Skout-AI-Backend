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

describe("Consent routes", () => {
  it("records consent and reports it as active for the caller's workspace", async () => {
    const app = await buildTestApp();
    const record = await app.inject({
      method: "POST",
      url: "/api/v1/consents",
      headers: json("consent-basic@test.com"),
      payload: { subjectType: "prospect", subjectId: "prospect-1", type: "email", basis: "opt_in" },
    });
    if (record.statusCode === 503) {
      await app.close();
      return;
    }
    expect(record.statusCode).toBe(201);

    const check = await app.inject({
      method: "GET",
      url: "/api/v1/consents/check?subjectType=prospect&subjectId=prospect-1&type=email",
      headers: asUser("consent-basic@test.com"),
    });
    expect(check.statusCode).toBe(200);
    expect((check.json() as { data: { hasActiveConsent: boolean } }).data.hasActiveConsent).toBe(true);
    await app.close();
  });

  describe("workspace isolation", () => {
    it("a consent recorded in one workspace is invisible to and cannot be revoked from another", async () => {
      const app = await buildTestApp();

      const record = await app.inject({
        method: "POST",
        url: "/api/v1/consents",
        headers: json("consent-iso-userA@test.com"),
        payload: { subjectType: "prospect", subjectId: "shared-subject-id", type: "email", basis: "opt_in" },
      });
      if (record.statusCode === 503) {
        await app.close();
        return;
      }
      const { id } = (record.json() as { data: { id: string } }).data;

      // Same subjectType/subjectId, different workspace — must not see workspace A's consent.
      const crossCheck = await app.inject({
        method: "GET",
        url: "/api/v1/consents/check?subjectType=prospect&subjectId=shared-subject-id&type=email",
        headers: asUser("consent-iso-userB@test.com"),
      });
      expect((crossCheck.json() as { data: { hasActiveConsent: boolean } }).data.hasActiveConsent).toBe(false);

      const crossRevoke = await app.inject({
        method: "POST",
        url: `/api/v1/consents/${id}/revoke`,
        headers: asUser("consent-iso-userB@test.com"),
      });
      expect(crossRevoke.statusCode).toBe(404);

      // Still active from the owning workspace's own view — the cross-workspace revoke attempt
      // must not have touched it.
      const ownCheck = await app.inject({
        method: "GET",
        url: "/api/v1/consents/check?subjectType=prospect&subjectId=shared-subject-id&type=email",
        headers: asUser("consent-iso-userA@test.com"),
      });
      expect((ownCheck.json() as { data: { hasActiveConsent: boolean } }).data.hasActiveConsent).toBe(true);

      await app.close();
    });
  });
});
