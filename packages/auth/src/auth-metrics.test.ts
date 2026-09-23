import { describe, expect, it, vi, beforeEach } from "vitest";

type Call = { level: "info" | "warn"; message: string; fields?: Record<string, unknown> };
const calls: Call[] = [];

// AUTH-BE-20 acceptance criterion: "redaction test proves no token/PII in logs". Mocking
// @skout/observability's createLogger (rather than trying to intercept pino's actual stdout
// write) is the reliable way to assert this: pino's default destination writes directly to the
// stdout file descriptor via sonic-boom, bypassing process.stdout.write entirely, so capturing
// real bytes isn't viable here. What actually matters for this acceptance criterion is the data
// handed to the logger — never a token/email field — which this captures exactly.
vi.mock("@skout/observability", () => ({
  createLogger: () => ({
    module: "auth.metrics",
    info: (message: string, fields?: Record<string, unknown>) => calls.push({ level: "info", message, fields }),
    warn: (message: string, fields?: Record<string, unknown>) => calls.push({ level: "warn", message, fields }),
  }),
}));

const {
  emitAuthVerifyMetric,
  emitAuthLoginMetric,
  emitAuthRefreshMetric,
  emitAuthRefreshReuseMetric,
} = await import("./auth-metrics.js");

describe("auth-metrics (AUTH-BE-20)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("emits auth.verify with issuer/result and no token/email fields", () => {
    emitAuthVerifyMetric({ issuer: "https://clerk.example.com", result: "success" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.level).toBe("info");
    expect(call!.fields).toEqual({ metric: "auth.verify", issuer: "https://clerk.example.com", result: "success" });
    const raw = JSON.stringify(call!.fields);
    expect(raw).not.toMatch(/token/i);
    expect(raw).not.toMatch(/@.*\.\w+/); // no email-shaped string
    expect(raw).not.toContain("Bearer ");
  });

  it("emits auth.login with only result + optional userId, never an email or password", () => {
    emitAuthLoginMetric({ result: "failure", userId: "user-123" });
    const [call] = calls;
    expect(call!.fields).toEqual({ metric: "auth.login", result: "failure", userId: "user-123" });
    expect(call!.fields).not.toHaveProperty("email");
    expect(call!.fields).not.toHaveProperty("password");
  });

  it("emits auth.refresh with only result + optional userId", () => {
    emitAuthRefreshMetric({ result: "success", userId: "user-456" });
    const [call] = calls;
    expect(call!.fields).toEqual({ metric: "auth.refresh", result: "success", userId: "user-456" });
    const raw = JSON.stringify(call!.fields);
    expect(raw).not.toMatch(/refreshToken|accessToken/i);
  });

  it("emits auth.refresh_reuse with only userId/sessionId, at warn level", () => {
    emitAuthRefreshReuseMetric({ userId: "user-789", sessionId: "session-abc" });
    const [call] = calls;
    expect(call!.level).toBe("warn");
    expect(call!.fields).toEqual({ metric: "auth.refresh_reuse", userId: "user-789", sessionId: "session-abc" });
  });

  it("omits userId entirely (not even an undefined key) when not provided", () => {
    emitAuthVerifyMetric({ issuer: "https://clerk.example.com", result: "failure" });
    const [call] = calls;
    expect(call!.fields).not.toHaveProperty("userId");
  });
});
