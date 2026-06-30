import { describe, expect, it } from "vitest";
import { isBusinessHour, nextBusinessHour, addCalendarDays, stepScheduledAt } from "./scheduling.js";

// 2026-01-01 is Thursday — so:
//   Mon = Jan 5, Tue = Jan 6, Wed = Jan 7, Thu = Jan 8, Fri = Jan 9
//   Sat = Jan 10, Sun = Jan 11, Mon = Jan 12
function utc(year: number, month: number, day: number, hour: number, min = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, min));
}

const MON = (h: number, m = 0) => utc(2026, 1, 5, h, m);  // 2026-01-05
const TUE = (h: number, m = 0) => utc(2026, 1, 6, h, m);  // 2026-01-06
const FRI = (h: number, m = 0) => utc(2026, 1, 9, h, m);  // 2026-01-09
const SAT = (h: number, m = 0) => utc(2026, 1, 10, h, m); // 2026-01-10
const SUN = (h: number, m = 0) => utc(2026, 1, 11, h, m); // 2026-01-11
const NEXT_MON = (h: number, m = 0) => utc(2026, 1, 12, h, m); // 2026-01-12

// ---------------------------------------------------------------------------
// isBusinessHour
// ---------------------------------------------------------------------------

describe("isBusinessHour", () => {
  it("returns true at exactly 09:00 on Monday (start boundary inclusive)", () => {
    expect(isBusinessHour(MON(9))).toBe(true);
  });

  it("returns true at 16:59 on Friday (inside window)", () => {
    expect(isBusinessHour(FRI(16, 59))).toBe(true);
  });

  it("returns false at exactly 17:00 (end boundary exclusive)", () => {
    expect(isBusinessHour(MON(17))).toBe(false);
  });

  it("returns false at 08:59 (one minute before start)", () => {
    expect(isBusinessHour(MON(8, 59))).toBe(false);
  });

  it("returns false on Saturday at 10:00", () => {
    expect(isBusinessHour(SAT(10))).toBe(false);
  });

  it("returns false on Sunday at 10:00", () => {
    expect(isBusinessHour(SUN(10))).toBe(false);
  });

  it("returns false on Friday at 18:00 (after hours)", () => {
    expect(isBusinessHour(FRI(18))).toBe(false);
  });

  it("returns true at midday on Tuesday", () => {
    expect(isBusinessHour(TUE(12))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nextBusinessHour
// ---------------------------------------------------------------------------

describe("nextBusinessHour", () => {
  it("returns input time unchanged when already in business hours", () => {
    const d = MON(10, 30);
    const result = nextBusinessHour(d);
    expect(result.toISOString()).toBe(d.toISOString());
  });

  it("advances before-09:00 weekday to 09:00 same day", () => {
    expect(nextBusinessHour(MON(7)).toISOString()).toBe(MON(9).toISOString());
  });

  it("advances exactly 08:59 weekday to 09:00 same day", () => {
    expect(nextBusinessHour(MON(8, 59)).toISOString()).toBe(MON(9).toISOString());
  });

  it("advances 17:00 weekday to 09:00 next weekday", () => {
    expect(nextBusinessHour(MON(17)).toISOString()).toBe(TUE(9).toISOString());
  });

  it("advances after-hours weekday to 09:00 next day", () => {
    expect(nextBusinessHour(MON(18)).toISOString()).toBe(TUE(9).toISOString());
  });

  it("advances Friday after-hours to Monday 09:00 (skips weekend)", () => {
    expect(nextBusinessHour(FRI(18)).toISOString()).toBe(NEXT_MON(9).toISOString());
  });

  it("advances Saturday to Monday 09:00", () => {
    expect(nextBusinessHour(SAT(12)).toISOString()).toBe(NEXT_MON(9).toISOString());
  });

  it("advances Sunday to Monday 09:00", () => {
    expect(nextBusinessHour(SUN(12)).toISOString()).toBe(NEXT_MON(9).toISOString());
  });

  it("does not mutate the input date", () => {
    const d = SAT(12);
    const before = d.toISOString();
    nextBusinessHour(d);
    expect(d.toISOString()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// addCalendarDays
// ---------------------------------------------------------------------------

describe("addCalendarDays", () => {
  it("returns a new Date copy when days is 0", () => {
    const d = MON(10);
    const result = addCalendarDays(d, 0);
    expect(result.toISOString()).toBe(d.toISOString());
    expect(result).not.toBe(d);
  });

  it("adds the correct number of days", () => {
    expect(addCalendarDays(MON(10), 3).toISOString()).toBe(utc(2026, 1, 8, 10).toISOString()); // Thu
  });

  it("crosses month boundary correctly", () => {
    const jan30 = utc(2026, 1, 30, 12);
    expect(addCalendarDays(jan30, 3).toISOString()).toBe(utc(2026, 2, 2, 12).toISOString());
  });

  it("crosses year boundary correctly", () => {
    const dec31 = utc(2025, 12, 31, 10);
    expect(addCalendarDays(dec31, 1).toISOString()).toBe(utc(2026, 1, 1, 10).toISOString());
  });

  it("does not mutate the input date", () => {
    const d = MON(10);
    const before = d.toISOString();
    addCalendarDays(d, 5);
    expect(d.toISOString()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// stepScheduledAt
// ---------------------------------------------------------------------------

describe("stepScheduledAt", () => {
  it("delayDays=0, reference in biz hours → same time", () => {
    const ref = MON(10);
    expect(stepScheduledAt(ref, 0).toISOString()).toBe(ref.toISOString());
  });

  it("delayDays=0, reference on Saturday → Monday 09:00", () => {
    expect(stepScheduledAt(SAT(12), 0).toISOString()).toBe(NEXT_MON(9).toISOString());
  });

  it("delayDays=1, reference Mon 10:00 → Tue 10:00 (still in biz hours after adding a day)", () => {
    expect(stepScheduledAt(MON(10), 1).toISOString()).toBe(TUE(10).toISOString());
  });

  it("delayDays=1, reference Fri 18:00 → next Mon 09:00 (Sat 18:00 is outside biz)", () => {
    expect(stepScheduledAt(FRI(18), 1).toISOString()).toBe(NEXT_MON(9).toISOString());
  });

  it("delayDays=3, reference Fri 10:00 → Mon 10:00 (Fri+3 = Mon which is biz hours)", () => {
    expect(stepScheduledAt(FRI(10), 3).toISOString()).toBe(NEXT_MON(10).toISOString());
  });

  it("delayDays=0, reference Mon 07:00 → Mon 09:00 (advance to start of day)", () => {
    expect(stepScheduledAt(MON(7), 0).toISOString()).toBe(MON(9).toISOString());
  });

  it("chained steps produce monotonically increasing scheduledAt", () => {
    const base = MON(10);
    const step1 = stepScheduledAt(base, 0);
    const step2 = stepScheduledAt(step1, 2);
    const step3 = stepScheduledAt(step2, 3);
    expect(step2.getTime()).toBeGreaterThan(step1.getTime());
    expect(step3.getTime()).toBeGreaterThan(step2.getTime());
  });
});
