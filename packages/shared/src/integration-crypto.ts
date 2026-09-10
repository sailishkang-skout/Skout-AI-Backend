import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM encrypt; payload is `iv:tag:ciphertext` (base64 segments). */
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
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("invalid_encrypted_payload");
  }
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Dual-key decrypt for INTEGRATION_ENCRYPTION_KEY rotation: try the current (new) key
 * first, then fall back to the previous key. Use during cutover while
 * `rotate-integration-encryption-key` re-encrypts rows.
 */
export function decryptSecretWithFallback(
  payload: string,
  primarySecret: string,
  previousSecret?: string | null
): string {
  try {
    return decryptSecret(payload, primarySecret);
  } catch (primaryErr) {
    if (!previousSecret) throw primaryErr;
    return decryptSecret(payload, previousSecret);
  }
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}
