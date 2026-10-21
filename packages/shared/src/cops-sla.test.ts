import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLA_POLICY,
  resolveSlaTarget,
  slaAddMinutes,
  slaClockStatus,
  slaDueAt,
  slaMeet,
  slaMinutesBetween,
  slaPause,
  slaPolicySchema,
  slaResume,
  type BusinessCalendar,
  type SlaClockState,
} from "./cops-sla.js";

const utc: BusinessCalendar = { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", holidays: [] };
const ny: BusinessCalendar = { ...utc, timezone: "America/New_York" };
const kolkata: BusinessCalendar = { ...utc, timezone: "Asia/Kolkata" };
const d = (iso: string) => new Date(iso);

describe("COPS-12 SLA clock math", () => {
  it("24x7 counts wall-clock minutes", () => {
    expect(slaMinutesBetween(d("2026-10-23T22:00:00Z"), d("2026-10-24T02:15:00Z"), "24x7", utc)).toBe(255);
    expect(slaAddMinutes(d("2026-10-24T23:50:00Z"), 15, "24x7", utc).toISOString()).toBe("2026-10-25T00:05:00.000Z");
  });

  it("business time skips nights and weekends: Friday 17:00 + 2h is Monday 10:00", () => {
    // 2026-10-23 is a Friday.
    expect(slaAddMinutes(d("2026-10-23T17:00:00Z"), 120, "business", utc).toISOString()).toBe("2026-10-26T10:00:00.000Z");
    expect(slaMinutesBetween(d("2026-10-23T17:00:00Z"), d("2026-10-26T10:00:00Z"), "business", utc)).toBe(120);
  });

  it("a ticket raised outside hours starts counting at the next opening", () => {
    // Saturday 08:00 + 60 business minutes = Monday 10:00.
    expect(slaAddMinutes(d("2026-10-24T08:00:00Z"), 60, "business", utc).toISOString()).toBe("2026-10-26T10:00:00.000Z");
    expect(slaMinutesBetween(d("2026-10-24T08:00:00Z"), d("2026-10-25T20:00:00Z"), "business", utc)).toBe(0);
  });

  it("one business day (540 minutes) from Tuesday 12:00 ends Wednesday 12:00", () => {
    expect(slaAddMinutes(d("2026-10-20T12:00:00Z"), 540, "business", utc).toISOString()).toBe("2026-10-21T12:00:00.000Z");
  });

  it("holidays are skipped", () => {
    const cal = { ...utc, holidays: ["2026-10-26"] };
    expect(slaAddMinutes(d("2026-10-23T17:00:00Z"), 120, "business", cal).toISOString()).toBe("2026-10-27T10:00:00.000Z");
  });

  it("works in a non-UTC timezone (Asia/Kolkata, UTC+05:30)", () => {
    // 09:00 IST Monday 2026-10-26 is 03:30 UTC; +60 business minutes is 04:30 UTC.
    expect(slaAddMinutes(d("2026-10-26T00:00:00Z"), 60, "business", kolkata).toISOString()).toBe("2026-10-26T04:30:00.000Z");
    // 18:00 IST Friday is 12:30 UTC; 12:00 UTC Friday + 60 business minutes rolls to Monday 09:30 IST (04:00 UTC).
    expect(slaAddMinutes(d("2026-10-23T12:00:00Z"), 60, "business", kolkata).toISOString()).toBe("2026-10-26T04:00:00.000Z");
  });

  it("is correct across a DST change (America/New_York, 2026-11-01)", () => {
    // Friday 2026-10-30 17:00 EDT (21:00 UTC) + 120 business minutes = Monday 2026-11-02 10:00 EST (15:00 UTC).
    expect(slaAddMinutes(d("2026-10-30T21:00:00Z"), 120, "business", ny).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(slaMinutesBetween(d("2026-10-30T21:00:00Z"), d("2026-11-02T15:00:00Z"), "business", ny)).toBe(120);
    // A whole working day is still 540 minutes on either side of the change.
    expect(slaMinutesBetween(d("2026-10-30T13:00:00Z"), d("2026-10-30T22:00:00Z"), "business", ny)).toBe(540);
    expect(slaMinutesBetween(d("2026-11-02T14:00:00Z"), d("2026-11-02T23:00:00Z"), "business", ny)).toBe(540);
  });

  it("add and between are inverse", () => {
    const start = d("2026-10-21T15:37:00Z");
    for (const m of [1, 59, 540, 541, 1620, 2700]) {
      const end = slaAddMinutes(start, m, "business", ny);
      expect(slaMinutesBetween(start, end, "business", ny)).toBe(m);
    }
  });
});

describe("COPS-12 SLA clock state", () => {
  const clock = (over: Partial<SlaClockState> = {}): SlaClockState => ({ kind: "resolution", targetMinutes: 540, calendar: "business", usedMinutes: 0, runningSince: d("2026-10-20T09:00:00Z"), metAt: null, breachedAt: null, ...over });

  it("pause banks the time used and resume moves the due time out by the paused span", () => {
    let c = clock();
    // 540 business minutes from Tuesday 09:00 is Tuesday 18:00.
    expect(slaDueAt(c, utc)!.toISOString()).toBe("2026-10-20T18:00:00.000Z");
    c = slaPause(c, d("2026-10-20T12:00:00Z"), utc);
    expect(c.usedMinutes).toBe(180);
    expect(slaDueAt(c, utc)).toBeNull();
    expect(slaClockStatus(c, d("2026-10-22T12:00:00Z"), utc, 0.75)).toBe("paused");
    // Paused for a full day; resumes Wednesday 12:00 with 360 minutes left -> due Wednesday 18:00.
    c = slaResume(c, d("2026-10-21T12:00:00Z"));
    expect(slaDueAt(c, utc)!.toISOString()).toBe("2026-10-21T18:00:00.000Z");
  });

  it("status moves from running to at risk (75%) to breached", () => {
    const c = clock();
    expect(slaClockStatus(c, d("2026-10-20T12:00:00Z"), utc, 0.75)).toBe("running");
    expect(slaClockStatus(c, d("2026-10-20T16:00:00Z"), utc, 0.75)).toBe("at_risk");
    expect(slaClockStatus(c, d("2026-10-21T09:01:00Z"), utc, 0.75)).toBe("breached");
  });

  it("meeting the target stops the clock; meeting it late records the breach", () => {
    const met = slaMeet(clock(), d("2026-10-20T15:00:00Z"), utc);
    expect(met).toMatchObject({ usedMinutes: 360, runningSince: null, breachedAt: null });
    expect(slaClockStatus(met, d("2026-10-30T00:00:00Z"), utc, 0.75)).toBe("met");
    const late = slaMeet(clock(), d("2026-10-21T10:00:00Z"), utc);
    expect(late.breachedAt).not.toBeNull();
    expect(slaClockStatus(late, d("2026-10-30T00:00:00Z"), utc, 0.75)).toBe("breached");
  });
});

describe("COPS-12 SLA policy", () => {
  it("defaults follow the Bible table and validate", () => {
    expect(slaPolicySchema.parse(DEFAULT_SLA_POLICY)).toBeTruthy();
    expect(resolveSlaTarget(DEFAULT_SLA_POLICY, "p1", "smb")).toEqual({ response: 15, resolution: 240, calendar: "24x7" });
    expect(resolveSlaTarget(DEFAULT_SLA_POLICY, "p2", "smb")).toEqual({ response: 60, resolution: 540, calendar: "business" });
    expect(resolveSlaTarget(DEFAULT_SLA_POLICY, "p4", "smb").resolution).toBe(2700);
  });

  it("a tier override wins for its tier only, and an unknown priority falls back to p3", () => {
    const policy = { ...DEFAULT_SLA_POLICY, tierOverrides: { enterprise: { p2: { response: 30, resolution: 270, calendar: "business" as const } } } };
    expect(resolveSlaTarget(policy, "p2", "enterprise").response).toBe(30);
    expect(resolveSlaTarget(policy, "p2", "smb").response).toBe(60);
    expect(resolveSlaTarget(policy, "urgent", "smb")).toEqual(DEFAULT_SLA_POLICY.targets.p3);
  });

  it("refuses a bad calendar", () => {
    expect(() => slaPolicySchema.parse({ ...DEFAULT_SLA_POLICY, calendar: { ...DEFAULT_SLA_POLICY.calendar, timezone: "Mars/Olympus" } })).toThrow();
    expect(() => slaPolicySchema.parse({ ...DEFAULT_SLA_POLICY, calendar: { ...DEFAULT_SLA_POLICY.calendar, start: "18:00", end: "09:00" } })).toThrow();
  });
});
