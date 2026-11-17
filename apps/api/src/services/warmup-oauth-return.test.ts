import { describe, expect, it } from "vitest";
import { warmupOAuthReturnUrl } from "./warmup-oauth-return.js";

const STG = { FRONTEND_URL: "https://stg.skoutai.io/app", CORS_ORIGIN: [] as string[] };

describe("warmupOAuthReturnUrl", () => {
  it("sends a successful connect back to the Mailboxes page", () => {
    const url = new URL(warmupOAuthReturnUrl(STG, "google", { status: 200, body: '{"status":"connected"}' }));
    expect(url.origin + url.pathname).toBe("https://stg.skoutai.io/app/warmup/mailboxes");
    expect(url.searchParams.get("oauth")).toBe("connected");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.has("reason")).toBe(false);
  });

  it("adds /app when FRONTEND_URL is the bare origin", () => {
    const url = new URL(warmupOAuthReturnUrl({ FRONTEND_URL: "https://x.test/", CORS_ORIGIN: [] }, "microsoft", { status: 200 }));
    expect(url.pathname).toBe("/app/warmup/mailboxes");
    expect(url.searchParams.get("provider")).toBe("microsoft");
  });

  it("carries the Warm-Up error code on failure", () => {
    const body = JSON.stringify({ error: { code: "OAUTH_STATE_INVALID", message: "State expired" } });
    const url = new URL(warmupOAuthReturnUrl(STG, "google", { status: 400, body }));
    expect(url.searchParams.get("oauth")).toBe("error");
    expect(url.searchParams.get("reason")).toBe("OAUTH_STATE_INVALID");
  });

  it("falls back to a generic reason when the body is not the expected shape", () => {
    expect(new URL(warmupOAuthReturnUrl(STG, "google", { status: 502, body: "<html>bad gateway</html>" })).searchParams.get("reason")).toBe("connect_failed");
    expect(new URL(warmupOAuthReturnUrl(STG, "google", { status: 500 })).searchParams.get("reason")).toBe("connect_failed");
  });

  it("accepts an explicit reason (e.g. service unavailable) and drops unsafe characters", () => {
    expect(new URL(warmupOAuthReturnUrl(STG, "google", { reason: "warmup_tool_unavailable" })).searchParams.get("reason")).toBe("warmup_tool_unavailable");
    const body = JSON.stringify({ error: { code: "<script>alert(1)</script>" } });
    expect(new URL(warmupOAuthReturnUrl(STG, "google", { status: 400, body })).searchParams.get("reason")).toBe("connect_failed");
  });

  it("uses the first CORS origin when FRONTEND_URL is unset", () => {
    const url = new URL(warmupOAuthReturnUrl({ CORS_ORIGIN: ["http://localhost:3000"] }, "google", { status: 200 }));
    expect(url.href).toBe("http://localhost:3000/app/warmup/mailboxes?oauth=connected&provider=google");
  });
});
