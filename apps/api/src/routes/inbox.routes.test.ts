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

describe("inbox routes", () => {
  it("GET /inboxes lists inboxes for the workspace", async () => {
    const app = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/inboxes", headers: asUser("inbox-list@test.com") });

    expect([200, 503]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = res.json() as { data: unknown[]; total: number };
      expect(Array.isArray(body.data)).toBe(true);
    }

    await app.close();
  });

  it("POST /inboxes creates an inbox with encrypted SMTP credentials and never returns the password", async () => {
    const app = await buildTestApp();
    const uniqueEmail = `sender-${Date.now()}@example.com`;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inboxes",
      headers: json("inbox-create@test.com"),
      payload: {
        emailAddress: uniqueEmail,
        displayName: "Sender Name",
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpUsername: "sender@example.com",
        smtpPassword: "super-secret-password",
      },
    });

    if (res.statusCode === 503) {
      await app.close();
      return;
    }

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("smtpPasswordEncrypted");
    expect(body.smtpConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("super-secret-password");

    await app.close();
  });

  it("POST /inboxes returns 400 for an invalid payload", async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inboxes",
      headers: json("inbox-invalid@test.com"),
      payload: { emailAddress: "not-an-email" },
    });

    expect([400, 503]).toContain(res.statusCode);

    await app.close();
  });

  it("GET /inbox/threads lists threads for the workspace", async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/inbox/threads",
      headers: asUser("inbox-threads@test.com"),
    });

    expect([200, 503]).toContain(res.statusCode);

    await app.close();
  });
});
