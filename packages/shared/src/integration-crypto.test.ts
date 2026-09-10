import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskApiKey } from "./integration-crypto.js";

describe("integration-crypto", () => {
  it("round-trips encryption", () => {
    const secret = "test-encryption-secret";
    const payload = encryptSecret("hunter_live_abc123xyz", secret);
    expect(payload).not.toContain("hunter_live");
    expect(decryptSecret(payload, secret)).toBe("hunter_live_abc123xyz");
  });

  it("masks api keys", () => {
    expect(maskApiKey("abcdefghijklmnop")).toBe("••••mnop");
  });
});
