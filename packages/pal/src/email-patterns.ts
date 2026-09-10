/**
 * Deterministic email pattern generation (strategy §5 Phase 1).
 * Produces ranked candidate addresses for a name + domain. No verification —
 * candidates must pass an EmailVerifier before being treated as valid.
 */

function clean(part: string): string {
  return part
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z]/g, "");
}

export function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = clean(parts[0] ?? "");
  const last = clean(parts.length > 1 ? parts[parts.length - 1] : "");
  return { first, last };
}

/** Returns candidate emails ordered most→least likely. */
export function generateEmailCandidates(fullName: string, domain: string): string[] {
  const { first, last } = splitName(fullName);
  const d = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!first || !d) return [];

  const fi = first[0];
  const li = last ? last[0] : "";

  const locals = last
    ? [
        `${first}.${last}`,
        `${first}${last}`,
        `${fi}${last}`,
        `${first}`,
        `${first}_${last}`,
        `${fi}.${last}`,
        `${first}${li}`,
        `${last}${fi}`,
      ]
    : [first];

  // De-dupe while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const local of locals) {
    const email = `${local}@${d}`;
    if (!seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}
