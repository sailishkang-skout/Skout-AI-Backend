import { describe, expect, it } from "vitest";
import { COPS_PHASE1_EVENTS } from "./copos-events.js";
import { COPS_RESOURCES } from "./cops-rbac.js";
import {
  analyticsSafeProperties,
  COPS_DASHBOARDS,
  COPS_METRICS,
  FUNNEL_STAGE_EVENTS,
  FUNNEL_STAGES,
  getMetric,
  metricsForDashboard,
  resolveWindow,
  serverAnalyticsEventName,
} from "./cops-metrics.js";

describe("COPS-13 metric catalog", () => {
  it("ids are unique, every metric has a definition, a known resource and at least one dashboard", () => {
    const ids = COPS_METRICS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of COPS_METRICS) {
      expect(d.definition.length).toBeGreaterThan(20);
      expect(COPS_RESOURCES).toContain(d.resource);
      expect(d.dashboards.length).toBeGreaterThan(0);
      expect(d.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("every source event a metric names is a registered domain event", () => {
    for (const d of COPS_METRICS) for (const e of d.sourceEvents) expect(Object.keys(COPS_PHASE1_EVENTS)).toContain(e);
    for (const stage of FUNNEL_STAGES) for (const e of FUNNEL_STAGE_EVENTS[stage]) expect(Object.keys(COPS_PHASE1_EVENTS)).toContain(e);
  });

  it("every dashboard has KPIs and the executive set covers the Bible p.59 list", () => {
    for (const dash of COPS_DASHBOARDS) expect(metricsForDashboard(dash).length).toBeGreaterThan(0);
    const leadership = metricsForDashboard("leadership").map((d) => d.id);
    for (const id of ["revenue.arr", "revenue.mrr", "revenue.pipeline", "trials.active", "activation.rate", "revenue.renewal_exposure", "engineering.critical_open", "ops.workflow_failures"]) {
      expect(leadership).toContain(id);
    }
    expect(getMetric("nope")).toBeUndefined();
  });
});

describe("COPS-13 warehouse feed helpers", () => {
  it("names server events canonically", () => {
    expect(serverAnalyticsEventName("TicketSlaBreached")).toBe("cops.server.ticket_sla_breached");
    expect(serverAnalyticsEventName("FirstLogin")).toBe("cops.server.first_login");
  });

  it("keeps ids, enums and numbers, and drops free text", () => {
    const out = analyticsSafeProperties({
      ticket_id: "t1",
      severity: "high",
      target_minutes: 60,
      reason: "Customer said the CFO is angry",
      evidence: [{ factor: "x", reason: "y" }],
      required_approvers: ["finance"],
    });
    expect(out).toEqual({ ticket_id: "t1", severity: "high", target_minutes: 60, required_approvers: ["finance"] });
  });
});

describe("COPS-13 window", () => {
  it("defaults to the last 30 days and refuses an inverted or too-long window", () => {
    const now = new Date("2026-10-21T00:00:00Z");
    const w = resolveWindow(undefined, undefined, now);
    expect(w.to).toEqual(now);
    expect(w.from).toEqual(new Date("2026-09-21T00:00:00Z"));
    expect(() => resolveWindow("2026-10-22T00:00:00Z", "2026-10-21T00:00:00Z")).toThrow("INVALID_WINDOW");
    expect(() => resolveWindow("2020-01-01T00:00:00Z", "2026-10-21T00:00:00Z")).toThrow("WINDOW_TOO_LONG");
  });
});
