import { describe, expect, it, vi } from "vitest";
import type { Env } from "../config/env.js";
import {
  buildClickUrl,
  buildOpenPixelUrl,
  decodeTrackingToken,
  injectTracking,
  recordTrackingEvent,
  TRANSPARENT_GIF,
} from "./tracking.service.js";

const env = { TRACKING_SIGNING_SECRET: "tracking-secret", PORT: 3001 } as unknown as Env;

describe("tracking.service", () => {
  describe("buildOpenPixelUrl / decodeTrackingToken", () => {
    it("round-trips enrollmentId + enrollmentStepId", () => {
      const url = buildOpenPixelUrl(env, "enr-1", "step-1");
      expect(url).toMatch(/^http:\/\/localhost:3001\/api\/v1\/track\/open\/.+$/);
      const token = url.split("/open/")[1]!;
      expect(decodeTrackingToken(env, token)).toEqual({ enrollmentId: "enr-1", enrollmentStepId: "step-1" });
    });
  });

  describe("buildClickUrl / decodeTrackingToken", () => {
    it("round-trips enrollmentId + enrollmentStepId + url", () => {
      const url = buildClickUrl(env, "enr-1", "step-1", "https://example.com/pricing");
      expect(url).toMatch(/^http:\/\/localhost:3001\/api\/v1\/track\/click\//);
      const token = url.split("/click/")[1]!;
      expect(decodeTrackingToken(env, token)).toEqual({
        enrollmentId: "enr-1",
        enrollmentStepId: "step-1",
        url: "https://example.com/pricing",
      });
    });
  });

  describe("decodeTrackingToken", () => {
    it("returns null for an invalid token", () => {
      expect(decodeTrackingToken(env, "garbage")).toBeNull();
    });
  });

  describe("injectTracking", () => {
    it("autolinks bare URLs into click-tracked anchors", () => {
      const { html } = injectTracking(env, "Check this out: https://example.com/page", "enr-1", "step-1");
      expect(html).toContain('<a href="http://localhost:3001/api/v1/track/click/');
      expect(html).toContain(">https://example.com/page</a>");
    });

    it("converts newlines to <br>", () => {
      const { html } = injectTracking(env, "line one\nline two", "enr-1", "step-1");
      expect(html).toContain("line one<br>\nline two");
    });

    it("escapes HTML-significant characters", () => {
      const { html } = injectTracking(env, `Tom & Jerry <3 "quotes"`, "enr-1", "step-1");
      expect(html).toContain("Tom &amp; Jerry &lt;3 &quot;quotes&quot;");
    });

    it("appends an invisible open-tracking pixel", () => {
      const { html } = injectTracking(env, "hello", "enr-1", "step-1");
      expect(html).toContain('<img src="http://localhost:3001/api/v1/track/open/');
      expect(html).toContain('width="1" height="1"');
    });

    it("preserves the original plain text unchanged", () => {
      const { text } = injectTracking(env, "Hi {{firstName}}, visit https://example.com", "enr-1", "step-1");
      expect(text).toBe("Hi {{firstName}}, visit https://example.com");
    });
  });

  describe("recordTrackingEvent", () => {
    it("inserts a tracking event row with the given fields", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      const db = { insert: vi.fn().mockReturnValue({ values }) } as any;

      await recordTrackingEvent(db, {
        workspaceId: "ws-1",
        enrollmentId: "enr-1",
        enrollmentStepId: "step-1",
        eventType: "open",
        userAgent: "test-agent",
        ipAddress: "127.0.0.1",
      });

      expect(values).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        enrollmentId: "enr-1",
        enrollmentStepId: "step-1",
        eventType: "open",
        url: null,
        userAgent: "test-agent",
        ipAddress: "127.0.0.1",
      });
    });

    it("defaults optional fields to null", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      const db = { insert: vi.fn().mockReturnValue({ values }) } as any;

      await recordTrackingEvent(db, {
        workspaceId: "ws-1",
        enrollmentId: "enr-1",
        enrollmentStepId: "step-1",
        eventType: "click",
      });

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ url: null, userAgent: null, ipAddress: null })
      );
    });
  });

  describe("TRANSPARENT_GIF", () => {
    it("is a non-empty GIF buffer", () => {
      expect(Buffer.isBuffer(TRANSPARENT_GIF)).toBe(true);
      expect(TRANSPARENT_GIF.length).toBeGreaterThan(0);
      expect(TRANSPARENT_GIF.subarray(0, 3).toString("ascii")).toBe("GIF");
    });
  });
});
