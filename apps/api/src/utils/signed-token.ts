import { createHmac, timingSafeEqual } from "node:crypto";

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** Signs a JSON-serializable payload as `base64url(payload).base64url(hmac)`. */
export function signToken<T>(payload: T, secret: string): string {
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = base64url(createHmac("sha256", secret).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

/** Verifies and decodes a token produced by {@link signToken}. Returns null if invalid/tampered. */
export function verifyToken<T>(token: string, secret: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];

  const expectedSig = base64url(createHmac("sha256", secret).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
