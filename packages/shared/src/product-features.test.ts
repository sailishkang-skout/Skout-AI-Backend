import { describe, expect, it } from "vitest";
import {
  FEATURE_API_PREFIXES,
  FEATURE_LABELS,
  PLAN_PRESETS,
  PRODUCT_FEATURES,
  featureForApiPath,
} from "./product-features.js";

describe("product feature catalog", () => {
  it("has exactly the twelve spec keys", () => {
    expect([...PRODUCT_FEATURES]).toEqual([
      "ai",
      "sequences",
      "linkedin",
      "inbox",
      "enrichment",
      "smart_lists",
      "tam",
      "workflows",
      "crm",
      "warmup",
      "meeting_voice",
      "analytics",
    ]);
  });

  it("gives every feature a label and at least one API prefix", () => {
    for (const f of PRODUCT_FEATURES) {
      expect(FEATURE_LABELS[f]).toBeTruthy();
      expect(FEATURE_API_PREFIXES[f].length).toBeGreaterThan(0);
    }
  });

  it("never maps one prefix to two features", () => {
    const all = PRODUCT_FEATURES.flatMap((f) => FEATURE_API_PREFIXES[f]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("maps API paths to features by their first segment", () => {
    expect(featureForApiPath("/api/v1/sequences/123?x=1")).toBe("sequences");
    expect(featureForApiPath("/api/v1/smart-lists")).toBe("smart_lists");
    expect(featureForApiPath("/api/v1/crm/deals")).toBe("crm");
    expect(featureForApiPath("/api/v1/warmup-tool/accounts")).toBe("warmup");
  });

  it("leaves account-level and unmapped routes ungated", () => {
    expect(featureForApiPath("/api/v1/auth/me")).toBeNull();
    expect(featureForApiPath("/api/v1/team/members")).toBeNull();
    expect(featureForApiPath("/api/v1/billing/subscription")).toBeNull();
    expect(featureForApiPath("/api/v1/lists")).toBeNull();
    expect(featureForApiPath("/health")).toBeNull();
  });

  it("does not match a segment that only starts like a prefix", () => {
    expect(featureForApiPath("/api/v1/aiming")).toBeNull();
  });

  it("presets turn every feature on with 500 credits", () => {
    for (const plan of ["full", "multichannel"] as const) {
      expect(PLAN_PRESETS[plan].credits).toBe(500);
      for (const f of PRODUCT_FEATURES) expect(PLAN_PRESETS[plan].features[f]).toBe(true);
    }
  });
});
