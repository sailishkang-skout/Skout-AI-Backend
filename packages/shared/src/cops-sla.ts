/**
 * COPS-12 ticket SLA (Bible p.52): the policy shape, its defaults, and the clock math. Pure, so
 * it is tested without a DB and shared with the frontend. Business time is computed in the
 * calendar's IANA timezone with Intl (no date library), so weekends, holidays and DST changes are
 * handled by walking each local working day.
 */
import { z } from "zod";

export const SLA_CLOCK_KINDS = ["response", "resolution"] as const;
export type SlaClockKind = (typeof SLA_CLOCK_KINDS)[number];
export const SLA_CALENDARS = ["24x7", "business"] as const;
export type SlaCalendarKind = (typeof SLA_CALENDARS)[number];
export const SLA_PRIORITIES = ["p1", "p2", "p3", "p4"] as const;
export type SlaPriority = (typeof SLA_PRIORITIES)[number];
export const SLA_TIERS = ["smb", "mid_market", "enterprise"] as const;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const businessCalendarSchema = z
  .object({
    timezone: z.string().min(1),
    /** 0 = Sunday ... 6 = Saturday. */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    start: hhmm,
    end: hhmm,
    /** Local dates (YYYY-MM-DD) with no business hours. */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  })
  .refine((c) => c.start < c.end, { message: "start must be before end" })
  .refine((c) => isValidTimeZone(c.timezone), { message: "unknown timezone" });
export type BusinessCalendar = z.infer<typeof businessCalendarSchema>;

const target = z.object({ response: z.number().int().min(1), resolution: z.number().int().min(1), calendar: z.enum(SLA_CALENDARS) });
export const slaPolicySchema = z
  .object({
    /** Minutes of calendar time per priority. A business day is the calendar's working day. */
    targets: z.object({ p1: target, p2: target, p3: target, p4: target }),
    /** Optional per-tier overrides, e.g. { enterprise: { p2: { response: 30, resolution: 270, calendar: "business" } } }. */
    tierOverrides: z.record(z.enum(SLA_TIERS), z.record(z.enum(SLA_PRIORITIES), target)).default({}),
    calendar: businessCalendarSchema,
    /** Statuses in which the clocks stop (explicit pause rules). */
    pauseStatuses: z.array(z.string()).default(["waiting_on_customer"]),
    /** Share of the target after which the clock is at risk and escalated. */
    atRiskRatio: z.number().gt(0).lt(1).default(0.75),
  })
  .strict();
export type SlaPolicy = z.infer<typeof slaPolicySchema>;
export type SlaTarget = z.infer<typeof target>;

/** Bible p.52 defaults on a 09:00-18:00 Mon-Fri calendar (a business day = 540 minutes). */
const BD = 9 * 60;
export const DEFAULT_SLA_POLICY: SlaPolicy = {
  targets: {
    p1: { response: 15, resolution: 4 * 60, calendar: "24x7" },
    p2: { response: 60, resolution: BD, calendar: "business" },
    p3: { response: 4 * 60, resolution: 3 * BD, calendar: "business" },
    p4: { response: BD, resolution: 5 * BD, calendar: "business" },
  },
  tierOverrides: {},
  calendar: { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", holidays: [] },
  pauseStatuses: ["waiting_on_customer"],
  atRiskRatio: 0.75,
};

export function resolveSlaTarget(policy: SlaPolicy, priority: string, tier: string): SlaTarget {
  const p = (SLA_PRIORITIES as readonly string[]).includes(priority) ? (priority as SlaPriority) : "p3";
  const override = (policy.tierOverrides as Record<string, Partial<Record<SlaPriority, SlaTarget>>>)[tier]?.[p];
  return override ?? policy.targets[p];
}

// ---------- timezone helpers ----------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}
function localParts(date: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +parts.year!, m: +parts.month!, d: +parts.day!, h: +parts.hour! % 24, mi: +parts.minute!, s: +parts.second! };
}

/** Offset of tz from UTC at `date`, in milliseconds (local - UTC). */
function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a local wall time in tz (the later instant on a DST overlap, a shift forward on a gap). */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");
const minutesOf = (hm: string) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);

/** The working interval of the local day (y-m-d) in UTC, or null for a non-working day. */
function workingInterval(y: number, m: number, d: number, cal: BusinessCalendar): [number, number] | null {
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (!cal.days.includes(weekday)) return null;
  if (cal.holidays.includes(`${y}-${pad(m)}-${pad(d)}`)) return null;
  const s = minutesOf(cal.start);
  const e = minutesOf(cal.end);
  return [zonedToUtc(y, m, d, Math.floor(s / 60), s % 60, cal.timezone).getTime(), zonedToUtc(y, m, d, Math.floor(e / 60), e % 60, cal.timezone).getTime()];
}

/** Local calendar days starting at the local date of `from`. */
function* localDays(from: Date, tz: string, max = 3700) {
  const p = localParts(from, tz);
  const base = Date.UTC(p.y, p.m - 1, p.d);
  for (let i = 0; i < max; i++) {
    const dt = new Date(base + i * 86_400_000);
    yield { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
}

const MIN = 60_000;

/** Calendar minutes between a and b (0 if b <= a). Business calendars count only working time. */
export function slaMinutesBetween(a: Date, b: Date, kind: SlaCalendarKind, cal: BusinessCalendar): number {
  if (b.getTime() <= a.getTime()) return 0;
  if (kind === "24x7") return Math.floor((b.getTime() - a.getTime()) / MIN);
  let total = 0;
  for (const day of localDays(a, cal.timezone)) {
    const iv = workingInterval(day.y, day.m, day.d, cal);
    const dayStart = zonedToUtc(day.y, day.m, day.d, 0, 0, cal.timezone).getTime();
    if (dayStart > b.getTime()) break;
    if (!iv) continue;
    const s = Math.max(iv[0], a.getTime());
    const e = Math.min(iv[1], b.getTime());
    if (e > s) total += e - s;
  }
  return Math.floor(total / MIN);
}

/** The instant `minutes` of calendar time after `start`. */
export function slaAddMinutes(start: Date, minutes: number, kind: SlaCalendarKind, cal: BusinessCalendar): Date {
  if (minutes <= 0) return start;
  if (kind === "24x7") return new Date(start.getTime() + minutes * MIN);
  let remaining = minutes * MIN;
  for (const day of localDays(start, cal.timezone)) {
    const iv = workingInterval(day.y, day.m, day.d, cal);
    if (!iv) continue;
    const s = Math.max(iv[0], start.getTime());
    if (s >= iv[1]) continue;
    const available = iv[1] - s;
    if (available >= remaining) return new Date(s + remaining);
    remaining -= available;
  }
  throw new Error("SLA target is beyond the calendar horizon");
}

// ---------- clock state ----------

export interface SlaClockState {
  kind: SlaClockKind;
  targetMinutes: number;
  calendar: SlaCalendarKind;
  /** Calendar minutes used before the current running stretch. */
  usedMinutes: number;
  /** Set while the clock runs; null while paused or finished. */
  runningSince: Date | null;
  metAt: Date | null;
  breachedAt: Date | null;
}

export type SlaClockStatus = "running" | "paused" | "at_risk" | "met" | "breached";

export function slaUsedMinutes(c: SlaClockState, now: Date, cal: BusinessCalendar): number {
  return c.usedMinutes + (c.runningSince ? slaMinutesBetween(c.runningSince, now, c.calendar, cal) : 0);
}

/** When the clock breaches if it keeps running; null while paused or finished. */
export function slaDueAt(c: SlaClockState, cal: BusinessCalendar): Date | null {
  if (!c.runningSince || c.metAt) return null;
  return slaAddMinutes(c.runningSince, Math.max(0, c.targetMinutes - c.usedMinutes), c.calendar, cal);
}

export function slaClockStatus(c: SlaClockState, now: Date, cal: BusinessCalendar, atRiskRatio: number): SlaClockStatus {
  if (c.metAt) return c.breachedAt ? "breached" : "met";
  const used = slaUsedMinutes(c, now, cal);
  if (c.breachedAt || used >= c.targetMinutes) return "breached";
  if (used >= c.targetMinutes * atRiskRatio) return "at_risk";
  return c.runningSince ? "running" : "paused";
}

/** Pause a running clock at `now`, banking the time used. */
export function slaPause(c: SlaClockState, now: Date, cal: BusinessCalendar): SlaClockState {
  if (!c.runningSince || c.metAt) return c;
  return { ...c, usedMinutes: slaUsedMinutes(c, now, cal), runningSince: null };
}

export function slaResume(c: SlaClockState, now: Date): SlaClockState {
  if (c.runningSince || c.metAt) return c;
  return { ...c, runningSince: now };
}

/** Stop the clock as met (or late, when the target was already used up). */
export function slaMeet(c: SlaClockState, now: Date, cal: BusinessCalendar): SlaClockState {
  if (c.metAt) return c;
  const used = slaUsedMinutes(c, now, cal);
  return { ...c, usedMinutes: used, runningSince: null, metAt: now, breachedAt: c.breachedAt ?? (used > c.targetMinutes ? now : null) };
}
