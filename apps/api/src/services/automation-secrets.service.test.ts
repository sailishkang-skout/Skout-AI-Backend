import { describe, expect, it, vi } from "vitest";
import { saveAutomationSecret, resolveAutomationSecret } from "./automation-secrets.service.js";

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
