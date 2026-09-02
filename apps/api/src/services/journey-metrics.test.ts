import { describe, expect, it } from "vitest";
import { formatJourneyMetricsPrometheus, incrJourneyMetric, journeyMetricsSnapshot } from "./journey-metrics.js";

describe("journey-metrics", () => {
  it("exports icp/tam/regional brief counters in Prometheus format", () => {
    incrJourneyMetric("icpApproved");
    incrJourneyMetric("tamApproved", 2);
    incrJourneyMetric("regionalBriefApproved", 3);

    const prom = formatJourneyMetricsPrometheus();
    expect(prom).toContain("skout_journey_icp_approved_total");
    expect(prom).toContain("skout_journey_tam_approved_total");
    expect(prom).toContain("skout_journey_regional_brief_approved_total");

    const snap = journeyMetricsSnapshot();
    expect(snap.icpApproved).toBeGreaterThanOrEqual(1);
    expect(snap.tamApproved).toBeGreaterThanOrEqual(2);
    expect(snap.regionalBriefApproved).toBeGreaterThanOrEqual(3);
  });
});
