/** Decode JWT segments without verifying — routing hints only (issuer, alg). */
function decodeJsonSegment(segment: string): unknown | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function peekJwtIssuer(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = decodeJsonSegment(parts[1]!);
  if (!payload || typeof payload !== "object") return null;
  const iss = (payload as { iss?: unknown }).iss;
  return typeof iss === "string" && iss.length > 0 ? iss : null;
}

export function peekJwtAlgorithm(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJsonSegment(parts[0]!);
  if (!header || typeof header !== "object") return null;
  const alg = (header as { alg?: unknown }).alg;
  return typeof alg === "string" ? alg : null;
}
