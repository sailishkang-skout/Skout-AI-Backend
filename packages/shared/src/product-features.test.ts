import { describe, expect, it } from "vitest";
import {
  OPT_IN_FEATURES,
  defaultFeatures,
  isOptInFeature,
  FEATURE_API_PREFIXES,
  FEATURE_LABELS,
  PLAN_PRESETS,
  PRODUCT_FEATURES,
  featureForApiPath,
} from "./product-features.js";

describe("product feature catalog", () => {
  it("has the twelve spec keys, then the opt-in WORKBOOKS_V2 switch", () => {
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
      "workbooks_v2",
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

  it("presets turn every general feature on with 500 credits, and leave opt-in features off", () => {
    for (const plan of ["full", "multichannel"] as const) {
      expect(PLAN_PRESETS[plan].credits).toBe(500);
      for (const f of PRODUCT_FEATURES) expect(PLAN_PRESETS[plan].features[f]).toBe(!isOptInFeature(f));
      expect(PLAN_PRESETS[plan].features.workbooks_v2).toBe(false);
    }
  });

  describe("WORKBOOKS_V2 (opt-in)", () => {
    it("is the only opt-in feature and is off by default while the rest are on", () => {
      expect([...OPT_IN_FEATURES]).toEqual(["workbooks_v2"]);
      const d = defaultFeatures();
      expect(d.workbooks_v2).toBe(false);
      for (const f of PRODUCT_FEATURES.filter((x) => x !== "workbooks_v2")) expect(d[f]).toBe(true);
    });

    it("gates /api/v1/workbooks-v2 and leaves the legacy /workbooks routes under enrichment", () => {
      expect(featureForApiPath("/api/v1/workbooks-v2/status")).toBe("workbooks_v2");
      expect(featureForApiPath("/api/v1/workbooks-v2")).toBe("workbooks_v2");
      expect(featureForApiPath("/api/v1/workbooks/123/runs")).toBe("enrichment");
      expect(featureForApiPath("/api/v1/workbooks-v22")).toBeNull();
    });
  });
});
