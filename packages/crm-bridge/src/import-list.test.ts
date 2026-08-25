import { describe, expect, it, vi } from "vitest";
import { importListToCrm } from "./import-list.js";

function selectChain(result: unknown[], terminal: "limit" | "where" = "limit") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.leftJoin = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

describe("importListToCrm", () => {
  it("throws when the list does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain([])),
    };
    await expect(importListToCrm(db as any, "ws-1", "list-1", "user-1")).rejects.toThrow("list_not_found");
  });

  it("upserts a company+contact per list member and reports created vs updated counts", async () => {
    const members = [
      { prospectId: "prospect-1", snapshot: { fullName: "Alice Chen", companyName: "Acme" } },
      { prospectId: "prospect-2", snapshot: { fullName: "Bob Lee", companyName: "Beta Inc" } },
    ];
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([])) // member 1: company lookup - miss
        .mockReturnValueOnce(selectChain([])) // member 1: contact lookup - miss
        .mockReturnValueOnce(selectChain([{ id: "company-existing" }])) // member 2: company lookup - hit
        .mockReturnValueOnce(selectChain([{ id: "contact-existing" }])), // member 2: contact lookup - hit
      insert: vi
        .fn()
        .mockReturnValueOnce(insertReturning([{ id: "company-1" }]))
        .mockReturnValueOnce(insertReturning([])) // audit: company-1
        .mockReturnValueOnce(insertReturning([{ id: "contact-1" }]))
        .mockReturnValueOnce(insertReturning([])), // audit: contact-1
    };
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ id: "list-1" }])) // list existence check
        .mockReturnValueOnce(selectChain(members, "where")), // member fetch
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    };

    const result = await importListToCrm(db as any, "ws-1", "list-1", "user-1");
    expect(result).toEqual({ imported: 2, created: 2, updated: 2 });
  });
});
