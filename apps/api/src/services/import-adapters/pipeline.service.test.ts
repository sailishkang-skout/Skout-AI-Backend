import { describe, expect, it, vi } from "vitest";

const listLists = vi.fn().mockResolvedValue([{ id: "l1", name: "My List", count: 5 }]);
const listContacts = vi.fn().mockResolvedValue([{ id: "c1" }]);
const mapToProspectCandidate = vi.fn((raw: { id: string }) => ({ companyDomain: `${raw.id}.com` }));

vi.mock("./hubspot.adapter.js", () => ({
  createHubSpotImportAdapter: vi.fn(() => ({ provider: "hubspot", listLists, listContacts, mapToProspectCandidate })),
}));
vi.mock("./apollo.adapter.js", () => ({
  createApolloImportAdapter: vi.fn(() => ({ provider: "apollo", listLists, listContacts, mapToProspectCandidate })),
}));

const { listProviderLists, listProviderContacts } = await import("./pipeline.service.js");

describe("import adapter pipeline", () => {
  it("routes to the hubspot adapter for provider=hubspot", async () => {
    const data = await listProviderLists({} as never, {} as never, "hubspot", "ws-1");
    expect(data).toEqual([{ id: "l1", name: "My List", count: 5 }]);
    expect(listLists).toHaveBeenCalledWith("ws-1");
  });

  it("maps raw contacts through the adapter's mapToProspectCandidate", async () => {
    const data = await listProviderContacts({} as never, {} as never, "apollo", "ws-1", undefined);
    expect(data).toEqual([{ companyDomain: "c1.com" }]);
  });

  it("rejects an unknown provider", async () => {
    await expect(listProviderLists({} as never, {} as never, "salesloft", "ws-1")).rejects.toThrow();
  });
});
