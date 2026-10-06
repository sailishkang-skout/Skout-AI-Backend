import { describe, expect, it } from "vitest";
import {
  INLINE_REF_PREFIX,
  decryptSecret,
  encryptSecret,
  reencrypt,
  reencryptInlineRef,
} from "./rotate-crypto.js";

const OLD = "old-key-0123456789abcdef";
const NEW = "new-key-0123456789abcdef";

describe("reencrypt", () => {
  it("re-encrypts a payload written under the old key so it decrypts with the new key", () => {
    const payload = encryptSecret("secret-value", OLD);
    const next = reencrypt(payload, OLD, NEW);
    expect(next).not.toBeNull();
    expect(decryptSecret(next!, NEW)).toBe("secret-value");
  });

  it("returns null (skip) for a payload already on the new key and for empty values", () => {
    expect(reencrypt(encryptSecret("x", NEW), OLD, NEW)).toBeNull();
    expect(reencrypt(null, OLD, NEW)).toBeNull();
    expect(reencrypt("", OLD, NEW)).toBeNull();
  });

  it("throws when the payload decrypts with neither key", () => {
    expect(() => reencrypt(encryptSecret("x", "some-other-key-0123456789"), OLD, NEW)).toThrow(/neither/);
  });
});

describe("reencryptInlineRef (HubSpot tokens carried in crm_connections.credentials_ref)", () => {
  const tokens = JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: "2030-01-01T00:00:00.000Z" });

  it("keeps the enc:v1: prefix and moves the ciphertext to the new key", () => {
    const ref = INLINE_REF_PREFIX + encryptSecret(tokens, OLD);
    const next = reencryptInlineRef(ref, OLD, NEW);
    expect(next).not.toBeNull();
    expect(next!.startsWith(INLINE_REF_PREFIX)).toBe(true);
    expect(decryptSecret(next!.slice(INLINE_REF_PREFIX.length), NEW)).toBe(tokens);
  });

  it("leaves refs that are not inline ciphertext untouched (AWS names, local refs, empty)", () => {
    expect(reencryptInlineRef("SkoutDev/crm/ws-1/hubspot", OLD, NEW)).toBeNull();
    expect(reencryptInlineRef("local:ws-1:hubspot", OLD, NEW)).toBeNull();
    expect(reencryptInlineRef(null, OLD, NEW)).toBeNull();
    expect(reencryptInlineRef("", OLD, NEW)).toBeNull();
  });

  it("skips an inline ref that is already on the new key", () => {
    expect(reencryptInlineRef(INLINE_REF_PREFIX + encryptSecret(tokens, NEW), OLD, NEW)).toBeNull();
  });

  it("throws for an inline ref that neither key can read, so rotation reports it instead of losing it", () => {
    expect(() => reencryptInlineRef(INLINE_REF_PREFIX + encryptSecret(tokens, "unrelated-key-0123456789"), OLD, NEW)).toThrow(
      /neither/
    );
  });
});
