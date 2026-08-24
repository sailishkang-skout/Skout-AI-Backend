import { describe, expect, it, vi } from "vitest";
import { upsertCompanyBySourceProspect, upsertContactBySourceProspect } from "./upsert.js";

function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

function makeTx(selects: unknown[][], inserts: (() => unknown)[]) {
  const tx = { select: vi.fn(), insert: vi.fn() };
  for (const result of selects) tx.select.mockReturnValueOnce(selectChain(result));
  for (const factory of inserts) tx.insert.mockReturnValueOnce(factory());
  return tx;
}

describe("upsertCompanyBySourceProspect", () => {
  it("returns the existing company id without inserting when already linked", async () => {
    const tx = makeTx([[{ id: "company-1" }]], []);
    const result = await upsertCompanyBySourceProspect(tx as any, "ws-1", "prospect-1", { companyName: "Acme" });
    expect(result.companyId).toBe("company-1");
    expect(result.created).toBe(false);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("creates a new company when none is linked yet", async () => {
    const tx = makeTx([[]], [() => insertReturning([{ id: "company-2" }])]);
    const result = await upsertCompanyBySourceProspect(tx as any, "ws-1", "prospect-1", {
      companyName: "Acme",
      companyDomain: "acme.com",
      industry: "Software",
      employeeCount: 50,
      location: "SF",
    });
    expect(result.companyId).toBe("company-2");
    expect(result.created).toBe(true);
  });
});

describe("upsertContactBySourceProspect", () => {
  it("returns the existing contact id without inserting when already linked", async () => {
    const tx = makeTx([[{ id: "contact-1" }]], []);
    const result = await upsertContactBySourceProspect(tx as any, "ws-1", "prospect-1", "company-1", {
      fullName: "Alice Chen",
    });
    expect(result.contactId).toBe("contact-1");
    expect(result.created).toBe(false);
  });

  it("creates a new contact, splitting fullName into first/last", async () => {
    const tx = makeTx([[]], [() => insertReturning([{ id: "contact-2" }])]);
    const result = await upsertContactBySourceProspect(tx as any, "ws-1", "prospect-1", "company-1", {
      fullName: "Alice Chen",
      email: "alice@acme.com",
    });
    expect(result.contactId).toBe("contact-2");
    expect(result.created).toBe(true);
  });
});
