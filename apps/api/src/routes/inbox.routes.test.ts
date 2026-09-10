import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

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

  it("POST /inboxes/:id/test-send returns 404 for a non-existent inbox", async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inboxes/00000000-0000-0000-0000-000000000000/test-send",
      headers: asUser("test-send@test.com"),
    });

    // 503 when DB unavailable, 404 when inbox not found
    expect([404, 503]).toContain(res.statusCode);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// R3.1 OAuth connect routes — share one app instance to avoid resource contention
// ---------------------------------------------------------------------------

describe("inbox OAuth connect routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it("GET /inboxes/connect/google redirects to Google auth or returns 503 when not configured", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/inboxes/connect/google",
      headers: asUser("oauth-google@test.com"),
    });

    // 302 when GOOGLE_CLIENT_ID is configured in .env, 503 when absent, 500 when DB unavailable
    expect([302, 503, 500]).toContain(res.statusCode);
    if (res.statusCode === 302) {
      expect(res.headers.location).toContain("accounts.google.com");
    }
  });

  it("GET /inboxes/connect/microsoft redirects to Microsoft auth or returns 503 when not configured", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/inboxes/connect/microsoft",
      headers: asUser("oauth-ms@test.com"),
    });

    expect([302, 503, 500]).toContain(res.statusCode);
    if (res.statusCode === 302) {
      expect(res.headers.location).toContain("login.microsoftonline.com");
    }
  });
});

describe("inbox manual-review routes", () => {
  it("GET /inbox/manual-review returns a shaped list", async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/inbox/manual-review",
      headers: asUser("manual-review-list@test.com"),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; total: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.total).toBe(body.data.length);

    await app.close();
  });

  it("POST /inbox/threads/:threadId/manual-review/resolve 404s for a thread that doesn't exist", async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inbox/threads/00000000-0000-0000-0000-000000000000/manual-review/resolve",
      headers: json("manual-review-resolve@test.com"),
      payload: { action: "dismiss" },
    });

    expect([404, 503]).toContain(res.statusCode);

    await app.close();
  });

  it("POST /inbox/threads/:threadId/manual-review/resolve rejects an invalid action", async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inbox/threads/00000000-0000-0000-0000-000000000000/manual-review/resolve",
      headers: json("manual-review-resolve-invalid@test.com"),
      payload: { action: "not_a_real_action" },
    });

    expect([400, 503]).toContain(res.statusCode);

    await app.close();
  });
});
