export const CADENCE_VALUES = ["off", "daily", "weekly"] as const;
export type SmartListRefreshCadence = (typeof CADENCE_VALUES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

const CADENCE_INTERVAL_MS: Record<Exclude<SmartListRefreshCadence, "off">, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

export function cadenceIntervalMs(cadence: Exclude<SmartListRefreshCadence, "off">): number {
  return CADENCE_INTERVAL_MS[cadence];
}

export function computeNextRefreshAt(cadence: SmartListRefreshCadence, from: Date): Date | null {
  if (cadence === "off") return null;
  return new Date(from.getTime() + cadenceIntervalMs(cadence));
}
