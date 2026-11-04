import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-09 regression, against the full app: the initial import used to live at
 * /crm/:provider/import, and for HubSpot the older static /crm/hubspot/import (list import)
 * matched first and answered invalid_import_source. The plugin-only route tests could not see it.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined });
}, 30000);

afterAll(async () => {
  await app?.close();
});

describe("CRM initial import route (full app)", () => {
  it("POST /crm/hubspot/initial-import reaches the initial import, not the list import", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/crm/hubspot/initial-import",
      headers: { "x-stub-user-email": "crm-initial-import-route@test.com", "content-type": "application/json" },
      payload: {},
    });
    expect(JSON.stringify(res.json())).not.toContain("invalid_import_source");
    // A workspace with no HubSpot connection: the initial import itself answers.
    expect(res.json()).toMatchObject({ statusCode: 404, message: "No CRM connection found for hubspot" });
  });
});
