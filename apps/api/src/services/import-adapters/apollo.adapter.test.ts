import { describe, expect, it, vi } from "vitest";

vi.mock("../integration.service.js", () => ({
  createIntegrationService: vi.fn(() => ({ getDecryptedProviderKey: vi.fn().mockResolvedValue("key-123") })),
}));

const { createApolloImportAdapter } = await import("./apollo.adapter.js");

describe("apollo import adapter", () => {
  const adapter = createApolloImportAdapter({} as never, {} as never);

  it("maps a full Apollo contact record to a ProspectSnapshot", () => {
    const snapshot = adapter.mapToProspectCandidate({
      id: "c1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@acme.com",
      title: "VP Eng",
      companyDomain: "acme.com",
      companyName: "Acme",
    });
    expect(snapshot).toEqual(
      expect.objectContaining({
        fullName: "Ada Lovelace",
        companyDomain: "acme.com",
        companyName: "Acme",
        email: "ada@acme.com",
        signals: ["apollo_import"],
      })
    );
  });

  it("drops a contact with no company domain", () => {
    expect(adapter.mapToProspectCandidate({ id: "c1", firstName: "Ada", email: "ada@acme.com" })).toBeNull();
  });

  it("drops a contact with a domain but no name or email", () => {
    expect(adapter.mapToProspectCandidate({ id: "c1", companyDomain: "acme.com" })).toBeNull();
  });
});
