/** Delimited string concatenation, not a hash — every part is already an opaque id, so a hash
 * buys nothing and costs debuggability (matches Warm-Up-Tool's reference implementation). */
export function buildIdempotencyKey(...parts: string[]): string {
  return parts.join(":");
}
