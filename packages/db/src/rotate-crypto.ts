import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Crypto helpers for rotate-integration-encryption-key.ts. They mirror @skout/shared integration-crypto
// (AES-256-GCM, payload `iv:tag:ciphertext` in base64) and are kept here so the rotation CLI has no
// dependency on the app packages.
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptSecret(payload: string, secret: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("invalid_encrypted_payload");
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Decrypt preferring old key; if already on new key, return null (= skip). */
export function reencrypt(payload: string | null | undefined, oldKey: string, newKey: string): string | null {
  if (!payload) return null;
  try {
    const plain = decryptSecret(payload, oldKey);
    return encryptSecret(plain, newKey);
  } catch {
    try {
      decryptSecret(payload, newKey);
      return null;
    } catch {
      throw new Error("ciphertext decrypts with neither old nor new key");
    }
  }
}

/** Prefix of HubSpot token refs that carry their own ciphertext (apps/api InlineEncryptedHubSpotCredentialsStore). */
export const INLINE_REF_PREFIX = "enc:v1:";

/**
 * Rotate a `crm_connections.credentials_ref` value. Returns the new ref, or null when there is nothing to
 * do (empty, not an inline ciphertext ref such as an AWS name, or already on the new key).
 */
export function reencryptInlineRef(
  ref: string | null | undefined,
  oldKey: string,
  newKey: string
): string | null {
  if (!ref || !ref.startsWith(INLINE_REF_PREFIX)) return null;
  const next = reencrypt(ref.slice(INLINE_REF_PREFIX.length), oldKey, newKey);
  return next ? INLINE_REF_PREFIX + next : null;
}
