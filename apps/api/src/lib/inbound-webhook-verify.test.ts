/**
 * §12 — Inbound Webhook Signature Verification — unit tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal Fastify request mock
// ---------------------------------------------------------------------------
function makeRequest(
  headers: Record<string, string>,
  body: unknown = { event: "test" }
): import("fastify").FastifyRequest {
  return {
    headers,
    rawBody: JSON.stringify(body),
    body,
  } as unknown as import("fastify").FastifyRequest;
}

function hmac(secret: string, timestampSec: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import {
  verifySkoutInboundSignature,
  verifyTelnyxWebhook,
  verifyGenericHmacWebhook,
} from "./inbound-webhook-verify.js";

const SECRET = "super-secret-key";
const BODY = JSON.stringify({ event: "test" });
const NOW_SEC = Math.floor(Date.now() / 1000);

describe("verifySkoutInboundSignature", () => {
  it("accepts a valid, fresh signature", () => {
    const sig = hmac(SECRET, NOW_SEC, BODY);
    const req = makeRequest({
      "x-skout-timestamp": String(NOW_SEC),
      "x-skout-signature": sig,
    });
    const result = verifySkoutInboundSignature(req, SECRET);
    expect(result.ok).toBe(true);
  });

  it("rejects when timestamp header is missing", () => {
    const req = makeRequest({ "x-skout-signature": "sha256=abc" });
    expect(verifySkoutInboundSignature(req, SECRET).ok).toBe(false);
    expect(verifySkoutInboundSignature(req, SECRET).reason).toContain("missing");
  });

  it("rejects when signature header is missing", () => {
    const req = makeRequest({ "x-skout-timestamp": String(NOW_SEC) });
    expect(verifySkoutInboundSignature(req, SECRET).ok).toBe(false);
  });

  it("rejects a signature with wrong secret", () => {
    const sig = hmac("wrong-secret", NOW_SEC, BODY);
    const req = makeRequest({
      "x-skout-timestamp": String(NOW_SEC),
      "x-skout-signature": sig,
    });
    expect(verifySkoutInboundSignature(req, SECRET).ok).toBe(false);
    expect(verifySkoutInboundSignature(req, SECRET).reason).toBe("signature_mismatch");
  });

  it("rejects a timestamp older than the replay window", () => {
    const staleTimestamp = NOW_SEC - 400; // 400s ago > 300s window
    const sig = hmac(SECRET, staleTimestamp, BODY);
    const req = makeRequest({
      "x-skout-timestamp": String(staleTimestamp),
      "x-skout-signature": sig,
    });
    const result = verifySkoutInboundSignature(req, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("too_old");
  });

  it("accepts a timestamp right at the window boundary", () => {
    const edgeTimestamp = NOW_SEC - 299;
    const sig = hmac(SECRET, edgeTimestamp, BODY);
    const req = makeRequest({
      "x-skout-timestamp": String(edgeTimestamp),
      "x-skout-signature": sig,
    });
    expect(verifySkoutInboundSignature(req, SECRET).ok).toBe(true);
  });

  it("rejects a non-numeric timestamp", () => {
    const req = makeRequest({
      "x-skout-timestamp": "not-a-number",
      "x-skout-signature": "sha256=abc",
    });
    expect(verifySkoutInboundSignature(req, SECRET).ok).toBe(false);
    expect(verifySkoutInboundSignature(req, SECRET).reason).toBe("invalid_timestamp_header");
  });
});

describe("verifyTelnyxWebhook", () => {
  it("passes through when Telnyx signature headers are absent (TeXML callback)", () => {
    const req = makeRequest({});
    expect(verifyTelnyxWebhook(req, SECRET).ok).toBe(true);
  });

  it("accepts valid Telnyx HMAC signature", () => {
    const sig = hmac(SECRET, NOW_SEC, BODY);
    const req = makeRequest({
      "telnyx-timestamp": String(NOW_SEC),
      "telnyx-signature-ed25519": sig,
    });
    expect(verifyTelnyxWebhook(req, SECRET).ok).toBe(true);
  });

  it("rejects a stale Telnyx timestamp", () => {
    const stale = NOW_SEC - 400;
    const sig = hmac(SECRET, stale, BODY);
    const req = makeRequest({
      "telnyx-timestamp": String(stale),
      "telnyx-signature-ed25519": sig,
    });
    const result = verifyTelnyxWebhook(req, SECRET);
    expect(result.ok).toBe(false);
  });
});

describe("verifyGenericHmacWebhook", () => {
  it("verifies a custom provider with custom header names", () => {
    const timestampSec = NOW_SEC;
    const sig = hmac(SECRET, timestampSec, BODY);
    const req = makeRequest({
      "x-custom-ts": String(timestampSec),
      "x-custom-sig": sig,
    });
    const result = verifyGenericHmacWebhook(req, {
      timestampHeader: "x-custom-ts",
      signatureHeader: "x-custom-sig",
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok:false when headers missing", () => {
    const req = makeRequest({});
    const result = verifyGenericHmacWebhook(req, {
      timestampHeader: "x-custom-ts",
      signatureHeader: "x-custom-sig",
      secret: SECRET,
    });
    expect(result.ok).toBe(false);
  });
});
