export const REPORT_CADENCE_VALUES = ["daily", "weekly", "monthly"] as const;
export type ReportCadence = (typeof REPORT_CADENCE_VALUES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same fixed-interval approach as smart-list-cadence.ts — monthly is a 30-day approximation, not calendar-aware. */
const CADENCE_INTERVAL_MS: Record<ReportCadence, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

export function computeNextSendAt(cadence: ReportCadence, from: Date): Date {
  return new Date(from.getTime() + CADENCE_INTERVAL_MS[cadence]);
}
