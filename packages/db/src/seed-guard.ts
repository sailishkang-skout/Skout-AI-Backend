/**
 * Shared helpers for the reference-data seeds that run on every staging deploy
 * (deploy/hetzner/scripts/run-migrations.sh). Each seed checks whether the data it would write is
 * already there and skips itself if so, so a normal deploy doesn't replay thousands of upserts or
 * overwrite values someone edited in the app.
 */

/** FORCE_SEED=1 (or true/yes) re-applies the seed data even when it is already present. */
export function seedForced(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes"].includes((env.FORCE_SEED ?? "").trim().toLowerCase());
}

/** Entries of `expected` that are not in `present`, in their original order and without duplicates. */
export function missingFrom<T>(expected: Iterable<T>, present: ReadonlySet<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of expected) {
    if (present.has(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export interface SeedStatus {
  /** What was checked, e.g. "regions". */
  label: string;
  expected: number;
  missing: number;
}

export const seedStatusComplete = (statuses: SeedStatus[]): boolean => statuses.every((s) => s.missing === 0);

/** One-line summary for deploy logs, e.g. "regions 19/19, countries 250/250". */
export function describeSeedStatus(statuses: SeedStatus[]): string {
  return statuses.map((s) => `${s.label} ${s.expected - s.missing}/${s.expected}`).join(", ");
}
