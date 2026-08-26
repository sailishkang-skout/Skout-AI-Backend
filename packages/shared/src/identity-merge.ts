/**
 * §5.2 (Enterprise Completion Plan) — probabilistic identity-merge scoring. Pure and
 * deterministic, no I/O: given two candidate records that don't share a deterministic key
 * (see identity.ts's hash-based generateProspectId/generateCompanyId), compute a 0..1
 * confidence score from whichever signals both candidates actually have. Never merges
 * anything itself — callers turn a score into a reviewed identity_merge_proposals row (see
 * apps/api/src/services/identity-merge.service.ts), which a human must approve before
 * anything is merged.
 */

export interface MatchCandidate {
  name?: string;
  domain?: string;
  title?: string;
  location?: string;
}

export interface MatchSignal {
  signal: keyof MatchCandidate;
  weight: number;
  contribution: number;
}

export interface MatchResult {
  score: number;
  signals: MatchSignal[];
}

/**
 * Case/whitespace-normalized Jaro-Winkler string similarity, 0..1. Self-contained (no
 * dependency) — standard algorithm for short-string fuzzy matching like person/company names.
 */
export function jaroWinkler(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] !== s2[i]) break;
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

const SIGNAL_WEIGHTS: Array<[keyof MatchCandidate, number]> = [
  ["name", 0.4],
  ["domain", 0.3],
  ["title", 0.15],
  ["location", 0.15],
];

/**
 * Combine available signals into one confidence score. Weights are re-normalized across
 * whichever signals both candidates actually have — a candidate missing a field simply
 * doesn't contribute that signal, rather than being penalized toward zero for a field neither
 * record was ever expected to carry.
 */
export function scoreCandidateMatch(a: MatchCandidate, b: MatchCandidate): MatchResult {
  const signals: MatchSignal[] = [];
  let totalWeight = 0;
  let weightedScore = 0;

  for (const [field, weight] of SIGNAL_WEIGHTS) {
    const av = a[field];
    const bv = b[field];
    if (!av || !bv) continue;
    const similarity = field === "domain" ? (av.trim().toLowerCase() === bv.trim().toLowerCase() ? 1 : 0) : jaroWinkler(av, bv);
    totalWeight += weight;
    weightedScore += weight * similarity;
    signals.push({ signal: field, weight, contribution: similarity });
  }

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;
  return { score, signals };
}

/** The line a candidate pair must clear to become a reviewed proposal — not to auto-merge. */
export const MERGE_PROPOSAL_MIN_SCORE = 0.72;
