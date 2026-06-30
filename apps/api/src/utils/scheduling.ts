/** Business hours window: Mon–Fri 09:00–17:00 UTC. */
const BIZ_START_HOUR = 9;
const BIZ_END_HOUR = 17;

export function isBusinessHour(date: Date): boolean {
  const day = date.getUTCDay(); // 0=Sun … 6=Sat
  const hour = date.getUTCHours();
  return day >= 1 && day <= 5 && hour >= BIZ_START_HOUR && hour < BIZ_END_HOUR;
}

/**
 * Advances `date` to the next moment that falls within business hours.
 * If already in business hours, returns a copy unchanged.
 */
export function nextBusinessHour(date: Date): Date {
  const d = new Date(date);
  if (isBusinessHour(d)) return d;

  const day = d.getUTCDay();
  const hour = d.getUTCHours();

  // Before 9 AM on a weekday — just push to 9 AM same day
  if (day >= 1 && day <= 5 && hour < BIZ_START_HOUR) {
    d.setUTCHours(BIZ_START_HOUR, 0, 0, 0);
    return d;
  }

  // After 5 PM weekday or any weekend — advance one calendar day at 9 AM,
  // then skip over weekends.
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(BIZ_START_HOUR, 0, 0, 0);
  const newDay = d.getUTCDay();
  if (newDay === 6) d.setUTCDate(d.getUTCDate() + 2); // Sat → Mon
  if (newDay === 0) d.setUTCDate(d.getUTCDate() + 1); // Sun → Mon

  return d;
}

/** Adds `days` calendar days to `date` (does not adjust for business hours). */
export function addCalendarDays(date: Date, days: number): Date {
  if (days === 0) return new Date(date);
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Returns the scheduledAt for a step:
 *   nextBusinessHour(referenceDate + delayDays calendar days)
 */
export function stepScheduledAt(referenceDate: Date, delayDays: number): Date {
  return nextBusinessHour(addCalendarDays(referenceDate, delayDays));
}
