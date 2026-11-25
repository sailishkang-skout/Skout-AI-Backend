import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Shared helpers for API keys: the CustomerOps keys (sk_cops_) and the public API keys
 * (sk_live_ / sk_test_, PAPI-021). Keys are random, stored only as a digest, and compared in
 * constant time.
 */

/** 12 lowercase hex chars: the public part of a key that finds its row. */
export function newKeyPrefix(): string {
  return randomBytes(6).toString("hex");
}

/** A base64url secret of `bytes` random bytes (24 → 32 chars, 32 → 43 chars). */
export function newKeySecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** HMAC-SHA256(value, pepper) as hex; with a server-side pepper a database dump alone can't test guesses. */
export function hmacSha256Hex(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

/** Constant-time comparison of two hex digests (false on any length mismatch). */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
