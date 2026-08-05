import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

describe("integration routes", () => {
  it("returns messaging and enrichment providers from /api/v1/integrations", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.workspaceId).toBe("00000000-0000-4000-8000-000000000001");

    const providers = body.data.map((i: { provider: string }) => i.provider);
    expect(providers).toContain("unipile");
    expect(providers).toContain("apollo");
    expect(providers).toContain("hunter");
    expect(providers).toContain("clearbit");

    const unipile = body.data.find((i: { provider: string }) => i.provider === "unipile");
    expect(unipile.category).toBe("messaging");
    expect(unipile.connected).toBe(false);

    const apollo = body.data.find((i: { provider: string }) => i.provider === "apollo");
    expect(apollo.category).toBe("enrichment");
    expect(apollo.connected).toBe(false);

    await app.close();
  });

  it("saves, tests, and removes an integration", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const save = await app.inject({
      method: "PUT",
      url: "/api/v1/integrations/apollo",
      payload: { apiKey: "test-key-1234567890" },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().data.connected).toBe(true);
    expect(save.json().data.keyHint).toContain("••••");

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/apollo",
    });
    expect(del.statusCode).toBe(204);

    await app.close();
  });
});
