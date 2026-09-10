/**
 * Common free/webmail domains a verification result is checked against for
 * an obvious typo (e.g. "gmial.com" -> "gmail.com") when the upstream email
 * intelligence service can't resolve the domain (UNKNOWN/NO_MX/DNS_ERROR).
 */
const COMMON_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "msn.com",
];

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) dist[0]![j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(
        dist[i - 1]![j]! + 1,
        dist[i]![j - 1]! + 1,
        dist[i - 1]![j - 1]! + cost
      );
    }
  }

  return dist[rows - 1]![cols - 1]!;
}

/**
 * Returns the common domain a given domain is most likely a typo of, or null
 * if it's an exact match or not close enough to any common domain to be a
 * confident suggestion.
 */
export function suggestDomainCorrection(domain: string): string | null {
  const normalized = domain.trim().toLowerCase();
  if (COMMON_DOMAINS.includes(normalized)) return null;

  let best: { candidate: string; distance: number } | null = null;
  for (const candidate of COMMON_DOMAINS) {
    const distance = levenshteinDistance(normalized, candidate);
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  if (!best) return null;

  const maxDistance = best.candidate.length <= 6 ? 1 : 2;
  return best.distance > 0 && best.distance <= maxDistance ? best.candidate : null;
}
