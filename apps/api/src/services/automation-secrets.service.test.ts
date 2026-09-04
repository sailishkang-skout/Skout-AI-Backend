import { describe, expect, it, vi } from "vitest";
import {
  listAutomationSecretValues,
  maskAutomationSecrets,
  resolveAutomationSecret,
  saveAutomationSecret,
} from "./automation-secrets.service.js";
import { encryptSecret } from "@skout/shared";

describe("automation-secrets.service", () => {
  it("round-trips a secret through save and resolve", async () => {
    let stored = "";
    const returning = vi.fn().mockImplementation(() => Promise.resolve([{ id: "secret-1" }]));
    const values = vi.fn().mockImplementation((row: { encryptedValue: string }) => {
      stored = row.encryptedValue;
      return { returning };
    });
    const insert = vi.fn().mockReturnValue({ values });
    const limit = vi.fn().mockImplementation(() => Promise.resolve([{ encryptedValue: stored }]));
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { insert, select } as any;
    const config = { INTEGRATION_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length!!" } as any;

    const saved = await saveAutomationSecret(db, config, "ws-1", "api-key", "super-secret-value");
    expect(saved.id).toBe("secret-1");

    const resolved = await resolveAutomationSecret(db, config, "ws-1", "secret-1");
    expect(resolved).toBe("super-secret-value");
  });
});

describe("maskAutomationSecrets", () => {
  it("redacts a secret value that is the entire string", () => {
    expect(maskAutomationSecrets("sk-live-abcdef123456", ["sk-live-abcdef123456"])).toBe("[REDACTED]");
  });

  it("redacts a secret value embedded inside a larger string", () => {
    expect(maskAutomationSecrets("Bearer sk-live-abcdef123456", ["sk-live-abcdef123456"])).toBe("Bearer [REDACTED]");
  });

  it("redacts every occurrence of a secret, nested arbitrarily deep in objects and arrays", () => {
    const value = {
      headers: { Authorization: "sk-live-abcdef123456" },
      log: ["attempt 1 failed", "retrying with sk-live-abcdef123456 again"],
    };
    const masked = maskAutomationSecrets(value, ["sk-live-abcdef123456"]);
    expect(JSON.stringify(masked)).not.toContain("sk-live-abcdef123456");
    expect(masked.headers.Authorization).toBe("[REDACTED]");
    expect(masked.log[1]).toBe("retrying with [REDACTED] again");
  });

  it("masks against multiple known secrets at once", () => {
    const value = { a: "key-one-xxxxxxxx", b: "key-two-yyyyyyyy" };
    const masked = maskAutomationSecrets(value, ["key-one-xxxxxxxx", "key-two-yyyyyyyy"]);
    expect(masked).toEqual({ a: "[REDACTED]", b: "[REDACTED]" });
  });

  it("leaves data untouched when there are no known secrets", () => {
    const value = { a: 1, b: "hello" };
    expect(maskAutomationSecrets(value, [])).toEqual(value);
  });

  it("passes through non-string, non-object values (numbers, booleans, null) unchanged", () => {
    expect(maskAutomationSecrets(42, ["sk-live-abcdef123456"])).toBe(42);
    expect(maskAutomationSecrets(null, ["sk-live-abcdef123456"])).toBeNull();
    expect(maskAutomationSecrets(true, ["sk-live-abcdef123456"])).toBe(true);
  });
});

describe("listAutomationSecretValues", () => {
  const config = { INTEGRATION_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length!!" } as any;

  function makeListDb(rows: { encryptedValue: string }[]) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { select } as any;
  }

  it("decrypts every secret configured for the workspace", async () => {
    const db = makeListDb([
      { encryptedValue: encryptSecret("secret-one-long-enough", config.INTEGRATION_ENCRYPTION_KEY) },
      { encryptedValue: encryptSecret("secret-two-long-enough", config.INTEGRATION_ENCRYPTION_KEY) },
    ]);
    const values = await listAutomationSecretValues(db, config, "ws-1");
    expect(values).toEqual(expect.arrayContaining(["secret-one-long-enough", "secret-two-long-enough"]));
    expect(values).toHaveLength(2);
  });

  it("excludes a secret below the minimum maskable length", async () => {
    const db = makeListDb([{ encryptedValue: encryptSecret("shortpw", config.INTEGRATION_ENCRYPTION_KEY) }]);
    const values = await listAutomationSecretValues(db, config, "ws-1");
    expect(values).toEqual([]);
  });

  it("skips (rather than throws on) a secret that fails to decrypt", async () => {
    const db = makeListDb([
      { encryptedValue: "not-a-valid-encrypted-payload" },
      { encryptedValue: encryptSecret("a-real-decryptable-secret", config.INTEGRATION_ENCRYPTION_KEY) },
    ]);
    const values = await listAutomationSecretValues(db, config, "ws-1");
    expect(values).toEqual(["a-real-decryptable-secret"]);
  });
});
