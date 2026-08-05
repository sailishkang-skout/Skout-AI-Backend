import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

describe("ai routes", () => {
  it("returns a ChatResponse from POST /api/v1/ai/chat", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      payload: {
        messages: [{ role: "user", content: "Take me to my inbox" }],
        mode: "ask",
        agent: "dexter",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.reply).toBe("string");
    expect(body.action).toMatchObject({ type: "navigate", path: "/inbox" });

    await app.close();
  });

  it("routes a search intent to prospects search", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      payload: {
        messages: [{ role: "user", content: "Find VP Sales in SaaS companies" }],
        mode: "ask",
        agent: "dexter",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.action.type).toBe("navigate");
    expect(body.action.path).toContain("/prospects/search");

    await app.close();
  });

  it("returns a graceful fallback for unknown intents", async () => {
    const config = loadEnv();
    const app = await buildApp({ ...config, LOG_LEVEL: "fatal" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      payload: {
        messages: [{ role: "user", content: "What is the meaning of life?" }],
        mode: "ask",
        agent: "dexter",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.action.type).toBe("none");
    expect(body.reply.length).toBeGreaterThan(0);

await app.close();
  });
});
